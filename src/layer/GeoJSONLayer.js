import LayerGroup from './LayerGroup';
import extend from 'lodash.assign';
import reqwest from 'reqwest';
import GeoJSON from '../util/GeoJSON';
import Buffer from '../util/Buffer';
import PickingMaterial from '../engine/PickingMaterial';
import PolygonLayer from './geometry/PolygonLayer';
import PolylineLayer from './geometry/PolylineLayer';

class GeoJSONLayer extends LayerGroup {
  constructor(geojson, options) {
    var defaults = {
      output: false,
      interactive: false,
      topojson: false,
      filter: null,
      onEachFeature: null,
      style: GeoJSON.defaultStyle
    };

    var _options = extend({}, defaults, options);

    if (typeof options.style === 'function') {
      _options.style = options.style;
    } else {
      _options.style = extend({}, defaults.style, options.style);
    }

    super(_options);

    this._geojson = geojson;
  }

  _onAdd(world) {
    // Only add to picking mesh if this layer is controlling output
    //
    // Otherwise, assume another component will eventually add a mesh to
    // the picking scene
    if (this.isOutput()) {
      this._pickingMesh = new THREE.Object3D();
      this.addToPicking(this._pickingMesh);
    }

    // Request data from URL if needed
    if (typeof this._geojson === 'string') {
      this._requestData(this._geojson);
    } else {
      // Process and add GeoJSON to layer
      this._processData(this._geojson);
    }
  }

  _requestData(url) {
    this._request = reqwest({
      url: url,
      type: 'json',
      crossOrigin: true
    }).then(res => {
      // Clear request reference
      this._request = null;
      this._processData(res);
    }).catch(err => {
      console.error(err);

      // Clear request reference
      this._request = null;
    });
  }

  // TODO: Wrap into a helper method so this isn't duplicated in the tiled
  // GeoJSON output layer
  //
  // Need to be careful as to not make it impossible to fork this off into a
  // worker script at a later stage
  _processData(data) {
    // Collects features into a single FeatureCollection
    //
    // Also converts TopoJSON to GeoJSON if instructed
    var geojson = GeoJSON.collectFeatures(data, this._options.topojson);

    // TODO: Check that GeoJSON is valid / usable

    var features = geojson.features;

    // Run filter, if provided
    if (this._options.filter) {
      features = geojson.features.filter(this._options.filter);
    }

    var defaults = {};

    // Assume that a style won't be set per feature
    var style = this._options.style;

    var options;
    features.forEach(feature => {
      // Get per-feature style object, if provided
      if (typeof this._options.style === 'function') {
        style = extend(GeoJSON.defaultStyle, this._options.style(feature));
      }

      options = extend({}, defaults, {
        // If merging feature layers, stop them outputting themselves
        // If not, let feature layers output themselves to the world
        output: !this.isOutput(),
        interactive: this._options.interactive,
        style: style
      });

      var layer = this._featureToLayer(feature, options);

      if (!layer) {
        return;
      }

      layer.feature = feature;

      // If defined, call a function for each feature
      //
      // This is commonly used for adding event listeners from the user script
      if (this._options.onEachFeature) {
        this._options.onEachFeature(feature, layer);
      }

      this.addLayer(layer);
    });

    // If merging layers do that now, otherwise skip as the geometry layers
    // should have already outputted themselves
    if (!this.isOutput()) {
      return;
    }

    // From here on we can assume that we want to merge the layers

    var polygonAttributes = [];
    var polygonFlat = true;

    var polylineAttributes = [];

    this._layers.forEach(layer => {
      if (layer instanceof PolygonLayer) {
        polygonAttributes.push(layer.getBufferAttributes());

        if (polygonFlat && !layer.isFlat()) {
          polygonFlat = false;
        }
      } else if (layer instanceof PolylineLayer) {
        polylineAttributes.push(layer.getBufferAttributes());
      }
    });

    var mergedPolygonAttributes = Buffer.mergeAttributes(polygonAttributes);
    var mergedPolylineAttributes = Buffer.mergeAttributes(polylineAttributes);

    this._setPolygonMesh(mergedPolygonAttributes, polygonFlat);
    this.add(this._polygonMesh);

    this._setPolylineMesh(mergedPolylineAttributes);
    this.add(this._polylineMesh);
  }

  // Create and store mesh from buffer attributes
  //
  // TODO: De-dupe this from the individual mesh creation logic within each
  // geometry layer (materials, settings, etc)
  _setPolygonMesh(attributes, flat) {
    var geometry = new THREE.BufferGeometry();

    // itemSize = 3 because there are 3 values (components) per vertex
    geometry.addAttribute('position', new THREE.BufferAttribute(attributes.vertices, 3));
    geometry.addAttribute('normal', new THREE.BufferAttribute(attributes.normals, 3));
    geometry.addAttribute('color', new THREE.BufferAttribute(attributes.colours, 3));

    if (attributes.pickingIds) {
      geometry.addAttribute('pickingId', new THREE.BufferAttribute(attributes.pickingIds, 1));
    }

    geometry.computeBoundingBox();

    var material;
    if (!this._world._environment._skybox) {
      material = new THREE.MeshPhongMaterial({
        vertexColors: THREE.VertexColors,
        side: THREE.BackSide
      });
    } else {
      material = new THREE.MeshStandardMaterial({
        vertexColors: THREE.VertexColors,
        side: THREE.BackSide
      });
      material.roughness = 1;
      material.metalness = 0.1;
      material.envMapIntensity = 3;
      material.envMap = this._world._environment._skybox.getRenderTarget();
    }

    mesh = new THREE.Mesh(geometry, material);

    mesh.castShadow = true;
    mesh.receiveShadow = true;

    if (flat) {
      material.depthWrite = false;
      mesh.renderOrder = 1;
    }

    if (this._options.interactive && this._pickingMesh) {
      material = new PickingMaterial();
      material.side = THREE.BackSide;

      var pickingMesh = new THREE.Mesh(geometry, material);
      this._pickingMesh.add(pickingMesh);
    }

    this._polygonMesh = mesh;
  }

  _setPolylineMesh(attributes) {
    var geometry = new THREE.BufferGeometry();

    // itemSize = 3 because there are 3 values (components) per vertex
    geometry.addAttribute('position', new THREE.BufferAttribute(attributes.vertices, 3));
    geometry.addAttribute('color', new THREE.BufferAttribute(attributes.colours, 3));

    if (attributes.pickingIds) {
      geometry.addAttribute('pickingId', new THREE.BufferAttribute(attributes.pickingIds, 1));
    }

    geometry.computeBoundingBox();

    // TODO: Make this work when style is a function per feature
    var style = this._options.style;
    var material = new THREE.LineBasicMaterial({
      vertexColors: THREE.VertexColors,
      linewidth: style.lineWidth,
      transparent: style.lineTransparent,
      opacity: style.lineOpacity,
      blending: style.lineBlending
    });

    var mesh = new THREE.LineSegments(geometry, material);

    if (style.lineRenderOrder !== undefined) {
      material.depthWrite = false;
      mesh.renderOrder = style.lineRenderOrder;
    }

    // TODO: Can a line cast a shadow?
    // mesh.castShadow = true;

    if (this._options.interactive && this._pickingMesh) {
      material = new PickingMaterial();
      material.side = THREE.BackSide;

      // Make the line wider / easier to pick
      material.linewidth = style.lineWidth + material.linePadding;

      var pickingMesh = new THREE.LineSegments(geometry, material);
      this._pickingMesh.add(pickingMesh);
    }

    this._polylineMesh = mesh;
  }

  // TODO: Support all GeoJSON geometry types
  _featureToLayer(feature, options) {
    var geometry = feature.geometry;
    var coordinates = (geometry.coordinates) ? geometry.coordinates : null;

    if (!coordinates || !geometry) {
      return;
    }

    if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
      return new PolygonLayer(coordinates, options);
    }

    if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') {
      return new PolylineLayer(coordinates, options);
    }
  }

  _abortRequest() {
    if (!this._request) {
      return;
    }

    this._request.abort();
  }

  // Destroy the layers and remove them from the scene and memory
  destroy() {
    // Cancel any pending requests
    this._abortRequest();

    // Clear request reference
    this._request = null;

    if (this._pickingMesh) {
      // TODO: Properly dispose of picking mesh
      this._pickingMesh = null;
    }

    // Run common destruction logic from parent
    super.destroy();
  }
}

export default GeoJSONLayer;

var noNew = function(geojson, options) {
  return new GeoJSONLayer(geojson, options);
};

export {noNew as geoJSONLayer};
