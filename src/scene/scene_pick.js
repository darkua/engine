pc.extend(pc, function () {

    /**
     * @name pc.Picker
     * @class Picker object used to select mesh instances from screen coordinates.
     * @constructor Create a new instance of a Picker object
     * @param {pc.GraphicsDevice} device Graphics device used to manage internal graphics resources.
     * @param {Number} width The width of the pick buffer in pixels.
     * @param {Number} height The height of the pick buffer in pixels.
     * @property {Number} width Width of the pick buffer in pixels (read-only).
     * @property {Number} height Height of the pick buffer in pixels (read-only).
     * @property {pc.RenderTarget} renderTarget The render target used by the picker internally (read-only).
     */
    var Picker = function(device, width, height) {
        this.device = device;

        var library = device.getProgramLibrary();
        this.pickProgStatic = library.getProgram('pick', {
            skin: false
        });
        this.pickProgSkin = library.getProgram('pick', {
            skin: true
        });

        this.pickColor = new Float32Array(4);

        this.scene = null;

        this.clearOptions = {
            color: [1, 1, 1, 1],
            depth: 1,
            flags: pc.CLEARFLAG_COLOR | pc.CLEARFLAG_DEPTH
        };
        this.resize(width, height);
    };

    /**
     * @function
     * @name pc.Picker#getSelection
     * @description Return the list of mesh instances selected by the specified rectangle in the
     * previously prepared pick buffer.
     * @param {Object} rect The selection rectangle.
     * @param {Number} rect.x The left edge of the rectangle
     * @param {Number} rect.y The bottom edge of the rectangle
     * @param {Number} [rect.width] The width of the rectangle
     * @param {Number} [rect.height] The height of the rectangle
     * @returns {Array} An array of mesh instances that are in the selection
     * @example
     * // Get the selection at the point (10,20)
     * var selection = picker.getSelection({
     *     x: 10,
     *     y: 20
     * });
     * 
     * // Get all models in rectangle with corners at (10,20) and (20,40)
     * var selection = picker.getSelection({
     *     x: 10,
     *     y: 20,
     *     width: 10,
     *     height: 20
     * });
     */
    Picker.prototype.getSelection = function (rect) {
        var device = this.device;

        rect.width = rect.width || 1;
        rect.height = rect.height || 1;

        // Cache active render target
        var prevRenderTarget = device.getRenderTarget();

        // Ready the device for rendering to the pick buffer
        device.setRenderTarget(this._pickBufferTarget);
        device.updateBegin();

        var pixels = new Uint8Array(4 * rect.width * rect.height);
        device.readPixels(rect.x, rect.y, rect.width, rect.height, pixels);

        device.updateEnd();

        // Restore render target
        device.setRenderTarget(prevRenderTarget);

        var selection = [];

        for (var i = 0; i < rect.width * rect.height; i++) {
            var r = pixels[4 * i + 0];
            var g = pixels[4 * i + 1];
            var b = pixels[4 * i + 2];
            var index = r << 16 | g << 8 | b;
            // White is 'no selection'
            if (index !== 0xffffff) {
                var selectedMeshInstance = this.scene.drawCalls[index];
                if (selection.indexOf(selectedMeshInstance) === -1) {
                    selection.push(selectedMeshInstance);
                }
            }
        }

        return selection;
    };

    /**
     * @function
     * @name pc.Picker#prepare
     * @description Primes the pick buffer with a rendering of the specified models from the point of view
     * of the supplied camera. Once the pick buffer has been prepared, pc.Picker#getSelection can be
     * called multiple times on the same picker object. Therefore, if the models or camera do not change 
     * in any way, pc.Picker#prepare does not need to be called again.
     * @param {pc.CameraNode} camera The camera used to render the scene, note this is the CameraNode, not an Entity
     * @param {pc.Scene} scene The scene containing the pickable mesh instances.
     */
    Picker.prototype.prepare = function (camera, scene) {
        var device = this.device;

        this.scene = scene;

        // Cache active render target
        var prevRenderTarget = device.getRenderTarget();

        // Ready the device for rendering to the pick buffer
        device.setRenderTarget(this._pickBufferTarget);
        device.updateBegin();
        device.setViewport(0, 0, this._pickBufferTarget.width, this._pickBufferTarget.height);
        device.setScissor(0, 0, this._pickBufferTarget.width, this._pickBufferTarget.height);
        device.clear(this.clearOptions);

        // Build mesh instance list (ideally done by visibility query)
        var i;
        var mesh, meshInstance, material;
        var type;
        var drawCalls = scene.drawCalls;
        var numDrawCalls = drawCalls.length;
        var device = this.device;
        var scope = device.scope;
        var modelMatrixId = scope.resolve('matrix_model');
        var boneTextureId = scope.resolve('texture_poseMap');
        var boneTextureSizeId = scope.resolve('texture_poseMapSize');
        var poseMatrixId = scope.resolve('matrix_pose[0]');
        var pickColorId = scope.resolve('uColor');
        var projId = scope.resolve('matrix_projection');
        var viewProjId = scope.resolve('matrix_viewProjection');

        var wtm = camera.getWorldTransform();
        var projMat = camera.getProjectionMatrix();
        var viewMat = wtm.clone().invert();
        var viewProjMat = new pc.Mat4();
        viewProjMat.mul2(projMat, viewMat);

        projId.setValue(projMat.data);
        viewProjId.setValue(viewProjMat.data);

        for (i = 0; i < numDrawCalls; i++) {
            if (!drawCalls[i].command) {
                meshInstance = drawCalls[i];
                mesh = meshInstance.mesh;
                material = meshInstance.material;

                type = mesh.primitive[pc.RENDERSTYLE_SOLID].type;
                var isSolid = (type === pc.PRIMITIVE_TRIANGLES) || (type === pc.PRIMITIVE_TRISTRIP) || (type === pc.PRIMITIVE_TRIFAN);
                var isPickable = (material instanceof pc.PhongMaterial) || (material instanceof pc.BasicMaterial);
                if (isSolid && isPickable) {

                    device.setBlending(false);
                    device.setCullMode(material.cull);
                    device.setDepthWrite(material.depthWrite);
                    device.setDepthTest(material.depthTest);

                    modelMatrixId.setValue(meshInstance.node.worldTransform.data);
                    if (meshInstance.skinInstance) {
                        if (device.supportsBoneTextures) {
                            boneTextureId.setValue(meshInstance.skinInstance.boneTexture);
                            var w = meshInstance.skinInstance.boneTexture.width;
                            var h = meshInstance.skinInstance.boneTexture.height;
                            boneTextureSizeId.setValue([w, h])
                        } else {
                            poseMatrixId.setValue(meshInstance.skinInstance.matrixPalette);                            
                        }
                    }

                    this.pickColor[0] = ((i >> 16) & 0xff) / 255;
                    this.pickColor[1] = ((i >> 8) & 0xff) / 255;
                    this.pickColor[2] = (i & 0xff) / 255;
                    this.pickColor[3] = 1;
                    pickColorId.setValue(this.pickColor);
                    device.setShader(mesh.skin ? this.pickProgSkin : this.pickProgStatic);

                    device.setVertexBuffer(mesh.vertexBuffer, 0);
                    device.setIndexBuffer(mesh.indexBuffer[pc.RENDERSTYLE_SOLID]);
                    device.draw(mesh.primitive[pc.RENDERSTYLE_SOLID]);
                }
            }
        }

        device.setViewport(0, 0, device.width, device.height);
        device.setScissor(0, 0, device.width, device.height);
        device.updateEnd();

        // Restore render target
        device.setRenderTarget(prevRenderTarget);
    };

    /**
     * @function
     * @name pc.Picker#resize
     * @description Sets the resolution of the pick buffer. The pick buffer resolution does not need
     * to match the resolution of the corresponding frame buffer use for general rendering of the 
     * 3D scene. However, the lower the resolution of the pick buffer, the less accurate the selection
     * results returned by pc.Picker#getSelection. On the other hand, smaller pick buffers will
     * yield greater performance, so there is a trade off.
     * @param {Number} width The width of the pick buffer in pixels.
     * @param {Number} height The height of the pick buffer in pixels.
     */
    Picker.prototype.resize = function (width, height) {
        var colorBuffer = new pc.Texture(this.device, {
            format: pc.PIXELFORMAT_R8_G8_B8_A8,
            width: width,
            height: height,
            autoMipmap: false
        });
        colorBuffer.minFilter = pc.FILTER_NEAREST;
        colorBuffer.magFilter = pc.FILTER_NEAREST;
        colorBuffer.addressU = pc.ADDRESS_CLAMP_TO_EDGE;
        colorBuffer.addressV = pc.ADDRESS_CLAMP_TO_EDGE;
        this._pickBufferTarget = new pc.RenderTarget(this.device, colorBuffer, { depth: true });
    };

    Object.defineProperty(Picker.prototype, 'renderTarget', {
        get: function() { return this._pickBufferTarget; }
    });

    Object.defineProperty(Picker.prototype, 'width', {
        get: function() { return this._pickBufferTarget.width; }
    });

    Object.defineProperty(Picker.prototype, 'height', {
        get: function() { return this._pickBufferTarget.height; }
    });

    return {
        Picker: Picker
    };
}());