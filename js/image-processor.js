/**
 * image-processor.js — client-side image sanitization for uploads.
 *
 * Apps Script doesn't have an image-processing API, so we do all
 * resizing / greyscale conversion in the browser via canvas before
 * the file is sent. The broker then just stages the already-clean
 * bytes.
 *
 * Public API: window.AHLImage.process(file, options) → Promise of
 *
 *   { name, contentType, dataB64, width, height, originalSize, finalSize }
 *
 * Options:
 *   maxBytes      — hard reject if the original file is larger
 *                   (default 10 MB; UI should also gate this).
 *   maxDimension  — pixel cap on the longer side; resize to fit
 *                   (default 1600).
 *   greyscale     — boolean; convert to greyscale (used for profile
 *                   photos by site policy).
 *   quality       — JPEG quality 0..1 (default .85).
 *
 * Always re-encodes as JPEG (smaller, predictable). PDF / non-image
 * files are passed through untouched (no resize, just base64).
 */
(function () {
  'use strict';

  var DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
  var DEFAULT_MAX_DIM   = 1600;
  var DEFAULT_QUALITY   = 0.85;

  function process(file, options) {
    options = options || {};
    var maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
    var maxDim   = options.maxDimension || DEFAULT_MAX_DIM;
    var quality  = options.quality != null ? options.quality : DEFAULT_QUALITY;

    if (!file) return Promise.reject(new Error('No file given'));
    if (file.size > maxBytes) {
      return Promise.reject(new Error(
        'File is too large (' + Math.round(file.size / 1024 / 1024 * 10) / 10 +
        ' MB). The limit is ' + Math.round(maxBytes / 1024 / 1024) + ' MB.'
      ));
    }

    // Non-images: just base64, pass through.
    if (file.type.indexOf('image/') !== 0) {
      return readAsBase64(file).then(function (b64) {
        return {
          name:         file.name,
          contentType:  file.type || 'application/octet-stream',
          dataB64:      b64,
          originalSize: file.size,
          finalSize:    file.size
        };
      });
    }

    // Images → load via <img> → draw onto canvas resized → optional
    // greyscale → encode as JPEG.
    return readAsDataUrl(file).then(function (dataUrl) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          var w = img.naturalWidth;
          var h = img.naturalHeight;
          var scale = 1;
          if (Math.max(w, h) > maxDim) scale = maxDim / Math.max(w, h);
          var dw = Math.round(w * scale);
          var dh = Math.round(h * scale);

          var canvas = document.createElement('canvas');
          canvas.width  = dw;
          canvas.height = dh;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, dw, dh);

          if (options.greyscale) {
            var data = ctx.getImageData(0, 0, dw, dh);
            var pixels = data.data;
            for (var i = 0; i < pixels.length; i += 4) {
              // Luminance-weighted average — matches what camera
              // sensors call "luma" (Rec. 601). Looks more natural
              // than a flat (R+G+B)/3.
              var lum = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
              pixels[i] = pixels[i + 1] = pixels[i + 2] = lum;
            }
            ctx.putImageData(data, 0, 0);
          }

          var outDataUrl = canvas.toDataURL('image/jpeg', quality);
          // Strip "data:image/jpeg;base64," prefix.
          var b64 = outDataUrl.replace(/^data:[^;]+;base64,/, '');
          var bytes = Math.floor(b64.length * 0.75);
          // Replace extension with .jpg since we always output JPEG.
          var name = (file.name || 'image').replace(/\.[a-z0-9]+$/i, '') + '.jpg';
          resolve({
            name:         name,
            contentType:  'image/jpeg',
            dataB64:      b64,
            width:        dw,
            height:       dh,
            originalSize: file.size,
            finalSize:    bytes
          });
        };
        img.onerror = function () { reject(new Error('Couldn\'t decode image')); };
        img.src = dataUrl;
      });
    });
  }

  function readAsBase64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () {
        var s = r.result;
        var b64 = s.replace(/^data:[^;]+;base64,/, '');
        resolve(b64);
      };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(file);
    });
  }
  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(file);
    });
  }

  window.AHLImage = { process: process };
})();
