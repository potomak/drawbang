// Pixel is a javascript pixel drawing library.

var PIXEL = function() {
  // Global constants.
  var VERSION     = '0.1',
      TRANSPARENT = "rgba(0, 0, 0, 0)";
  
  // Global variables.
  var debug           = false,
      matrix          = [],
      frames          = [],
      animation       = null,
      currentFrame    = 0,
      mainCanvas      = null,
      previewCanvases = [],
      drawing         = false,
      action          = "pixel",
      settings = {
        previewCanvas: {
          pixelSize: 1,
          size:      16,
          gridColor: "#eeeeee",
          showGrid:  false
        },
        mainCanvas: {
          pixelSize: 20,
          size:      320,
          gridColor: "#eeeeee",
          showGrid:  false
        }
      },
      history = {
        undo:    []
      };
  
  // Initializes Pixel library.
  //
  // `mainCanvas` is a HTML5 canvas elements.<br/>
  // `previewCanvases` is an array of HTML5 canvas elements.<br/>
  // `debug` is a flag to override default debug settings.<br/>
  // `imageData` an array containing bitmap image data.
  var init = function(aMainCanvas, aPreviewCanvases, aDebug, imageData) {
    mainCanvas = new Canvas(aMainCanvas, settings.mainCanvas);
    for(var i = 0; i < aPreviewCanvases.length; i++) {
      previewCanvases[i] = new Canvas(aPreviewCanvases[i], settings.previewCanvas);
    }
    typeof aDebug != 'undefined' ? debug = aDebug : null;

    initFrame();
    typeof imageData != 'undefined' ? loadImageData(imageData) : null;
    initCanvas();
  }
  
  // Initializes current frame bitmap values to `TRANSPARENT`.
  var initFrame = function() {
    var length = settings.mainCanvas.size/settings.mainCanvas.pixelSize;
    frames[currentFrame] = new Bitmap(length, length);
  }
  
  // Initializes canvas and history.
  var initCanvas = function() {
    history = {
      undo: []
    };
    
    draw();
  }

  // Loads image data.
  var loadImageData = function(imageData) {
    // Copy image data first frame to main canvas bitmap data.
    mainCanvas.clearCanvas();
    mainCanvas.draw(imageData[0]);

    for(var i = 0; i < imageData.length; i++) {
      frames[i] = new Bitmap(imageData[i].length, imageData.length);
      frames[i].importBitmapData(imageData[i]);

      previewCanvases[i].clearCanvas();
      previewCanvases[i].draw(imageData[i]);
    }
  }
  
  // Logs `obj` to `console` if `debug` flag is `true`.
  var log = function(obj) {
    debug && console.log([(new Date()).toString(), obj]);
  }
  
  // Sets `drawing` attribute.
  var setDraw = function(wantToDraw) {
    drawing = wantToDraw;
  }
  
  // Sets `action` attribute.
  var setAction = function(wantedAction) {
    action = wantedAction;
  }
  
  // Clears canvas at `index`.
  var clearCanvasAt = function(index) {
    log("clearCanvasAt:" + index + ", frames.length: " + frames.length);

    previewCanvases[index].clearCanvas();
    currentFrame == index && mainCanvas.clearCanvas();
  }
  
  // Removes frame object from `frames` at `index`.
  var removeFrame = function(index) {
    frames.splice(index, 1);
    log("removeFrame:" + index + ", frames.length: " + frames.length);
  }
  
  // Executes `action` at (`x`, `y`) with `color`.
  var doAction = function(x, y, color) {
    if(drawing) {
      var coords = {
        x: mainCanvas.quantize(x),
        y: mainCanvas.quantize(y)
      }
      
      switch(action) {
        case "pixel":
          var startColor = drawPixel(coords.x, coords.y, color);
          
          if(startColor != false) {
            history.undo.push(function() {
              drawPixel(coords.x, coords.y, startColor);
            });
          }
          
          break;
          
        case "clearPixel":
          var startColor = drawPixel(coords.x, coords.y, TRANSPARENT);
          
          if(startColor != false) {
            history.undo.push(function() {
              drawPixel(coords.x, coords.y, startColor);
            });
          }
          
          break;
          
        case "fill":
          var startBitmap = fillPixels(coords.x, coords.y, color);
          
          if(startColor != false) {
            history.undo.push(function() {
              draw(startBitmap);
            });
          }
          
          break;
          
        default:
          log("unknown action:" + action);
      }
    }
  }

  // Draws pixel at (`x`, `y`) of `color`.
  var drawPixel = function(x, y, color) {
    var startColor = getCurrentFrame().data[x][y];
    
    if(startColor != color) {
      getCurrentFrame().data[x][y] = color;
      draw();
      
      return startColor;
    }
    
    return false;
  }
  
  // Fills pixels.
  var fillPixels = function(x, y, color) {
    var startColor = getCurrentFrame().getColorAt(x, y);
    log("flood fill startColor: " + startColor + ", color: " + color + ", (" + x + ", " + y + ")");
    
    if(startColor != color) {
      var startBitmap = getCurrentFrame().clone();
      var t0 = new Date().getTime();
          
      fillPixel(x, y, startColor, color);
      log("flood fill time: " + (new Date().getTime()-t0));

      draw();
      
      return startBitmap.data;
    }
    
    return false;
  }
  
  // Recursive part of `fillPixels` function.
  //
  // `x`<br/>
  // `y`<br/>
  // `startColor` a hex representation of starting color.<br/>
  // `endColor` a hex representation of target color.
  var fillPixel = function(x, y, startColor, endColor) {
    if(x >= 0 && x < getCurrentFrame().data.length && y >= 0 && y < getCurrentFrame().data.length) {
      if(getCurrentFrame().getColorAt(x, y) == startColor) {
        getCurrentFrame().data[x][y] = endColor;

        fillPixel(x+1, y, startColor, endColor);
        fillPixel(x-1, y, startColor, endColor);
        fillPixel(x, y+1, startColor, endColor);
        fillPixel(x, y-1, startColor, endColor);
      }
    }
  }
  
  // Draws main canvas and preview canvas at `currentFrame` using `bitmap` as
  // bitmap data or `getCurrentFrame().data` if `bitmap` is `undefined`.
  var draw = function(bitmap) {
    if(typeof bitmap == 'undefined') {
      bitmap = getCurrentFrame().data;
    }
    else {
      frames[currentFrame] = new Bitmap(bitmap.length, bitmap.length);
      getCurrentFrame().importBitmapData(bitmap);
    }

    mainCanvas.clearCanvas();
    previewCanvases[currentFrame].clearCanvas();

    mainCanvas.draw(bitmap);
    previewCanvases[currentFrame].draw(bitmap);
  }
  
  // Returns history object.
  var getHistory = function() {
    return history;
  }
  
  // Undoes latest action.
  var undo = function() {
    if(history.undo.length > 0) {
      var todo = history.undo.pop();
      todo.call();
    }
  }

  // Returns `frames` length.
  var getFramesLength = function() {
    return frames.length;
  }

  // Returns bitmat data for frame at `index`.
  var getFrameAt = function(index) {
    return frames[index];
  }
  
  // Returns current frame data matrix.
  var getCurrentFrame = function() {
    return frames[currentFrame];
  }
  
  // Returns current frame id.
  var getCurrentFrameId = function() {
    return currentFrame;
  }
  
  // Sets current frame at `index`.
  var setCurrentFrame = function(index) {
    log("setCurrentFrame: " + index);
    var prevFrame = currentFrame;
    
    currentFrame = index;
    typeof getCurrentFrame() == 'undefined' && initFrame();
    prevFrame != currentFrame && initCanvas();
  }
  
  // Plays animation at `fps` frames per second.
  //
  // At every frame redraw `callback` is called.
  var play = function(fps, callback) {
    if(frames.length > 1) {
      animation = setInterval(function() {
        activeFrame = (currentFrame+1)%frames.length;
        log([
          "play animation",
          "activeFrame: " + activeFrame,
          "currentFrame: " + currentFrame,
          "frames.length: " + frames.length
        ]);
        setCurrentFrame(activeFrame);
        callback(activeFrame);
      }, (1/fps)*1000);
    }
  }
  
  // Stops animation.
  var stop = function() {
    clearInterval(animation);
    animation = null;
  }
  
  // Moves canvas top by one pixel.
  var moveTop = function() {
    applyTransformation(function() {
      // For each column of pixels
      for(var i = 0; i < getCurrentFrame().data.length; i++) {
        // push at beginning of column latest array element.
        getCurrentFrame().data[i].push(getCurrentFrame().data[i].shift());
      }
    });
  }
  
  // Moves canvas right by one pixel.
  var moveRight = function() {
    applyTransformation(function() {
      // For each row of pixels:
      for(j = 0; j < getCurrentFrame().data[0].length; j++) {
        // save latest row pixel to `temp` buffer,
        var temp = getCurrentFrame().data[getCurrentFrame().data.length-1][j];
        
        // shift elements by row,
        for(i = getCurrentFrame().data.length - 1; i > 0; i--) {
          getCurrentFrame().data[i][j] = getCurrentFrame().data[i-1][j];
        }
        
        // set first row element as `temp`.
        getCurrentFrame().data[0][j] = temp;
      }
    });
  }
  
  // Flips canvas vertically.
  var flipVertical = function() {
    applyTransformation(function() {
      // For each column of pixels,
      for(var i = 0; i < getCurrentFrame().data.length; i++) {
        // for half of each row of pixels,
        for(var j = 0; j < getCurrentFrame().data[i].length/2; j++) {
          var temp = getCurrentFrame().data[i][j];
          var length = getCurrentFrame().data[i].length;
          
          // swap first half column with second half.
          getCurrentFrame().data[i][j] = getCurrentFrame().data[i][length-1-j];
          getCurrentFrame().data[i][length-1-j] = temp;
        }
      }
    });
  }
  
  // Flips canvas horizontally.
  var flipHorizontal = function() {
    applyTransformation(function() {
      var length = getCurrentFrame().data.length;

      // For half of each column of pixels,
      for(var i = 0; i < getCurrentFrame().data.length/2; i++) {
        // for each row of pixels,
        for(var j = 0; j < getCurrentFrame().data[i].length; j++) {
          var temp = getCurrentFrame().data[i][j];

          // swap first half row with second half.
          getCurrentFrame().data[i][j] = getCurrentFrame().data[length-1-i][j];
          getCurrentFrame().data[length-1-i][j] = temp;
        }
      }
    });
  }
  
  // Rotates canvas left by 90 degrees.
  var rotate = function() {
    applyTransformation(function(startBitmap) {
      // For each column of pixels,
      for(var i = 0; i < getCurrentFrame().data.length; i++) {
        // for each row of pixels,
        for(var j = 0; j < getCurrentFrame().data[i].length; j++) {
          // swap each element to swap row with column.
          getCurrentFrame().data[i][j] = startBitmap.data[getCurrentFrame().data[i].length-1 - j][i];
        }
      }
    });
  }
  
  // Copies frame at `index` to current frame.
  //
  // `index` an integer representing an index of `frames` array.
  var pasteFrameAt = function(index) {
    applyTransformation(function(startBitmap, index) {
      frames[currentFrame] = getFrameAt(index).clone();
    }, index);
  }

  // Makes a copy of current frame, applies f and redraw canvas.
  //
  // `f` a transformation function.
  var applyTransformation = function(f) {
    var t0 = (new Date()).getTime();
    var args = Array.prototype.slice.call(arguments, 1);
    var startBitmap = getCurrentFrame().clone();
    
    f.apply(this, [startBitmap].concat(args));
    
    log("applyTransformation, " + args + " - " + ((new Date()).getTime()-t0));
    
    draw();
    
    history.undo.push(function() {
      draw(startBitmap.data);
    });
  }

  // Returns an object representation of the drawing.
  var toObject = function() {
    var data = {image: null};

    if(frames.length > 1) {
      data['image'] = {frames: []};
      for(var i = 0; i < frames.length; i++) {
        data['image']['frames'].push(getFrameAt(i).data);
      }
    }
    else {
      data['image'] = {frame: getCurrentFrame().data};
    }

    return data;
  }
  
  return {
    TRANSPARENT: TRANSPARENT,
    init: init,
    clearCanvasAt: clearCanvasAt,
    removeFrame: removeFrame,
    setDraw: setDraw,
    setAction: setAction,
    doAction: doAction,
    getHistory: getHistory,
    undo: undo,
    getFramesLength: getFramesLength,
    setCurrentFrame: setCurrentFrame,
    getCurrentFrame: getCurrentFrame,
    getCurrentFrameId: getCurrentFrameId,
    play: play,
    stop: stop,
    moveRight: moveRight,
    moveTop: moveTop,
    flipHorizontal: flipHorizontal,
    flipVertical: flipVertical,
    rotate: rotate,
    pasteFrameAt: pasteFrameAt,
    toObject: toObject,
    log: log
  };
}();


// A canvas object.
//
// `canvas` a canvas element.<br/>
// `settings` an object with settings to draw this canvas.
function Canvas(canvas, settings) {
  // A canvas element.
  this.canvas = canvas;
  
  // Context element of `canvas`
  this.ctx = canvas.getContext("2d");
  
  // An object with canvas settings.
  //
  // Example settings:
  //
  //     {
  //       pixelSize: 1,
  //       size:      16,
  //       gridColor: "#eeeeee",
  //       showGrid:  false
  //     }
  this.settings = settings;
  
  // Clears canvas.
  this.clearCanvas = function() {
    this.canvas.width = this.canvas.width;
  }
  
  // Draws canvas grid.
  this.drawGrid = function() {
    var correction = 0.5;

    for (var x = correction+this.settings.pixelSize; x < this.settings.size; x += this.settings.pixelSize) {
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, this.settings.size);
      this.ctx.moveTo(0, x);
      this.ctx.lineTo(this.settings.size, x);
    }

    this.ctx.strokeStyle = this.settings.gridColor;
    this.ctx.stroke();
  }
  
  // Returns canvas data url string as `image/png`.
  this.getDataURL = function() {
    return this.canvas.toDataURL("image/png");
  }
  
  // Draws canvas using `bitmap` as bitmap data.
  this.draw = function(bitmap) {
    this.clearCanvas();

    for(var i = 0; i < bitmap.length; i++) {
      for(var j = 0; j < bitmap[i].length; j++) {
        this.ctx.fillStyle = bitmap[i][j];
        this.ctx.fillRect(i*this.settings.pixelSize, j*this.settings.pixelSize, this.settings.pixelSize, this.settings.pixelSize);
      }
    }

    this.settings.showGrid && this.drawGrid();
  }

  // Returns quantized value of `val` by `settings.pixelSize`.
  //
  // `val` a number.
  this.quantize = function(val) {
    var i = Math.floor(val/this.settings.pixelSize);
    var max = this.settings.size/this.settings.pixelSize;
    
    i >= max && (i = max-1);
    i <= 0 && (i = 0);
    
    return i;
  }
}


// A bitmap object.
//
// `width` bitmap width.<br/>
// `height` bitmap height.
function Bitmap(width, height) {
  // Bitmap size.
  this.width = width;
  this.height = height;

  // Bitmap data.
  this.data = [];
  
  for(var x = 0; x < width; x++) {
    this.data.push(new Array(height));

    for(var y = 0; y < this.data[x].length; y++) {
      this.data[x][y] = PIXEL.TRANSPARENT;
    }
  }

  // Returns a formatted string representing the bitmap.
  this.toString = function() {
    var string = "";

    for(var x = 0; x < this.data.length; x++) {
      for(var y = 0; y < this.data[x].length; y++) {
        string += (PIXEL.TRANSPARENT == this.data[x][y] ? " " : "X") + ", ";
      }
      
      string += "\n";
    }
    
    return string;
  }

  // Returns a clone object.
  this.clone = function() {
    var clone = new Bitmap(this.width, this.height);

    for(var x = 0; x < this.data.length; x++) {
      clone.data[x] = this.data[x].slice();
    }

    return clone;
  }

  // Imports bitmap data from `bitmapData`.
  this.importBitmapData = function(bitmapData) {
    this.data = bitmapData.slice();

    for(var x = 0; x < bitmapData.length; x++) {
      this.data[x] = bitmapData[x].slice();
    }
  }

  // Returns color string at (`x`, `y`).
  //
  // Color string format:getColorAt
  //
  //     /#([a-fA-F0-9]{2})([a-fA-F0-9]{2})([a-fA-F0-9]{2})/
  this.getColorAt = function(x, y) {
    return PIXEL.TRANSPARENT == this.data[x][y] ? null : this.data[x][y];
  }
}