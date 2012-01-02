var currentColor = "#000000",
    frames = 1;

function postUploadCallback(data) {
  if(typeof data.thumb != 'undefined') {
    $("#images").prepend(data.thumb);
    
    clearAll();
    trackEvent('Save', data.url);
    showFacebookDialog(data.share_url, data.url);
  }
  else {
    alert(data);
  }
}

function performUpload() {
  var data = {image: null},
      lastFrameNotNull = -1,
      lastFrameNotNullFound = false;
  
  for(var i = 1; i < maxFrames && !lastFrameNotNullFound; i++) {
    if(PIXEL.getFrame(i) == null) {
      lastFrameNotNull = i-1;
      lastFrameNotNullFound = true;
    }
  }
  
  PIXEL.log(['lastFrameNotNull', lastFrameNotNull]);
  
  if(0 != lastFrameNotNull) {
    -1 == lastFrameNotNull && (lastFrameNotNull = 15);
    
    // NOTE: workaround to populate frames matrix
    for(var i = 0; i < lastFrameNotNull+1; i++) {
      PIXEL.setCurrentFrame((PIXEL.getCurrentFrameId()+1) % (lastFrameNotNull+1));
    }
    
    data['image'] = {frames: []};
    for(var i = 0; i < lastFrameNotNull+1; i++) {
      data['image']['frames'].push(PIXEL.getFrame(i));
    }
  }
  else {
    data['image'] = {frame: PIXEL.getCurrentFrame()};
  }
  
  $.ajax({
    url: '/upload',
    type: "POST",
    contentType: "application/json",
    processData: false,
    data: JSON.stringify(data),
    success: postUploadCallback,
    dataType: "json"
  });
  
  $("#upload.enabled").unbind('click').removeClass('enabled');
  $("#upload").addClass('disabled');
}

function upload() {
  if(confirm("Want to save?")) {
    if(typeof user_uid != 'undefined') {
      performUpload();
    }
    else {
      trying_to_save = true;
      $("a.popup").trigger('click');
    }
  }
  
  return false;
}

function ctrlKey(e) {
  return navigator.platform.match(/mac/i) ? e.metaKey : e.ctrlKey;
}

// clear all frames, disable all frames except the first one and make first frame active
function clearAll() {
  for(var i = 0; i < frames; i++) {
    PIXEL.setCurrentFrame(i);
    PIXEL.clearCanvas();
    disable($(".frame[data-frame=" + i + "]"));
  }
  deactivate($(".frame.active"));
  activate($(".frame[data-frame=0]"));
  enable($(".frame[data-frame=0]"));
  PIXEL.setCurrentFrame(0);
  PIXEL.clearCanvas();
  frames = 1;
}

// deactivate element
function deactivate($el) {
  $el.removeClass("active");
}

// activate element
function activate($el) {
  $el.addClass("active");
}

// disable element
function disable($el) {
  $el.addClass("disabled");
}

// enable element
function enable($el) {
  $el.removeClass("disabled");
}

// is element enabled?
function isEnabled($el) {
  return !$el.hasClass("disabled");
}

// track event
function trackEvent(e, url) {
  _gaq.push(['_trackEvent', 'Drawings', e, url]);
}

// show facebook wall post dialog
function showFacebookDialog(share_url, image_url) {
  FB.ui({
    method: 'feed',
    name: 'My brand new drawing',
    link: share_url,
    picture: image_url,
    caption: 'Check my drawing out!',
    description: 'Do you like it?',
    message: 'Check my drawing out!',
    actions: [{name: 'Draw!', link: 'http://drawbang.com/'}]
  },
  function(response) {
    if (response && response.post_id) {
      trackEvent('Post', image_url);
    } else {
      // alert('Post was not published.');
    }
  });
}

// returns mouse or tap event relative coordinates
function getCoordinates(e) {
  var x, y;
  
  x = e.offsetX ? e.offsetX : e.pageX - e.target.parentNode.offsetLeft;
  y = e.offsetY ? e.offsetY : e.pageY - e.target.parentNode.offsetTop;
  
  return {x: x, y: y};
}

// mouse down event callback
function mouseDownCallback(e) {
  PIXEL.setDraw(true);
  var coordinates = getCoordinates(e);
  
  PIXEL.log(['mouseDownCallback', e]);
  
  PIXEL.doAction(coordinates.x, coordinates.y, currentColor);
  
  $("#upload.disabled").bind('click', upload).removeClass('disabled');
  $("#upload").addClass('enabled');
}

// mouse move event callback
function mouseMoveCallback(e) {
  var coordinates = getCoordinates(e);
  
  PIXEL.doAction(coordinates.x, coordinates.y, currentColor);
  e.preventDefault();
}

// mouse up event callback
function mouseUpCallback() {
  PIXEL.setDraw(false);
}

$(document).ready(function() {
  var canvas = $("#canvas canvas"),
      previewCanvases = $('.frames canvas'),
      zKey = 90;

  PIXEL.init(canvas[0], previewCanvases, !production_env);

  // set drawing on mousedown
  canvas.mousedown(mouseDownCallback).mousemove(mouseMoveCallback);
  canvas.bind('touchstart', mouseDownCallback).bind('touchmove', mouseMoveCallback);

  // reset drawing on mouseup
  $(document).mouseup(mouseUpCallback);
  $(document).bind('touchend', mouseUpCallback);
  
  // if shift is pressed set color to transparent
  $(document).keydown(function(e) {
    if(!ctrlKey(e) && e.shiftKey) {
      currentColor = "rgba(0, 0, 0, 0)";
      $(".clearPixel").addClass('active');
    }
  });
  
  // reset color to current active color
  $(document).keyup(function(e) {
    currentColor = $(".color.active").data('color');
    if($(".action.selectable.active").data('action') != "clearPixel") {
      $(".clearPixel").removeClass('active');
    }
  });

  // controls
  $("#clear").click(function() {
    if($("#upload").hasClass('enabled') && confirm("Sure?")) {
      PIXEL.clearCanvas();
    
      $("#upload.enabled").unbind('click').removeClass('enabled');
      $("#upload").addClass('disabled');
    }
  });

  $(".action.selectable").click(function() {
    PIXEL.setAction($(this).data('action'));
    
    $(".action.selectable.active").toggleClass("active");
    $(this).toggleClass("active");
  });

  // colors
  $(".color").click(function() {
    currentColor = $(this).data('color');
    
    $(".color.active").toggleClass("active");
    $(this).toggleClass("active");
  });

  // undo / redo
  $(document).keydown(function(e) {
    if(ctrlKey(e) && e.keyCode == zKey) {
      if(e.shiftKey) {
        PIXEL.redo();
      }
      else {
        PIXEL.undo();
      }
      
      return false;
    }
  });
  
  ["undo", "redo"].forEach(function(action) {
    $("." + action).click(function() {
      pixel[action].call();
    });
  });
  
  $(".frame").click(function() {
    if(isEnabled($(this))) {
      PIXEL.setCurrentFrame($(this).data('frame'));
    
      $(".frame.active").toggleClass("active");
      $(this).toggleClass("active");
    }
  });
  
  // add frame
  $(".add_frame").click(function() {
    if(isEnabled($(this))) {
      frames++;
      maxFrames == frames && disable($(this));
      enable($(".remove_frame"));
      
      enable($(".frame[data-frame=" + (frames-1) + "]"));
      $(".frame.active").toggleClass("active");
      $(".frame[data-frame=" + (frames-1) + "]").toggleClass("active");
      
      PIXEL.setCurrentFrame(frames-1);
      
      PIXEL.log(['add_frame', frames]);
    }
  });
  
  // remove frame
  $(".remove_frame").click(function() {
    PIXEL.log(['remove_frame', this]);
    
    if(isEnabled($(this))) {
      frames--;
      1 == frames && disable($(this));
      enable($(".add_frame"));
      
      disable($(".frame[data-frame=" + frames + "]"));
      $(".frame.active").toggleClass("active");
      $(".frame[data-frame=" + (frames-1) + "]").toggleClass("active");
      
      PIXEL.clearCanvas();
      PIXEL.setCurrentFrame(frames-1);
      
      PIXEL.log(['remove_frame', frames]);
    }
  });
  
  // NOTE: deprecated
  /*
  $(".onion").click(function() {
    if($(this).data().frame == PIXEL.getCurrentOnionFrameId()) {
      PIXEL.setOnionFrame(null);
    }
    else {
      PIXEL.setOnionFrame($(this).data().frame);
      $(".onion.active").toggleClass("active");
    }
    
    $(this).toggleClass("active");
  });
  */
  
  $(".play_stop").click(function() {
    if($(this).hasClass("stop")) {
      PIXEL.stop();
    }
    else {
      PIXEL.play(5, function(frame) {
        $(".frame.active").toggleClass("active");
        $(".frame").each(function() {
          $(this).data('frame') == frame && $(this).toggleClass("active");
        });
      });
    }
    
    $(this).toggleClass("stop");
  });
  
  $(".move_right").click(function() {
    PIXEL.moveRight()
  });
  
  $(".move_top").click(function() {
    PIXEL.moveTop()}
  );
  
  $(".flip_horizontal").click(function() {
    PIXEL.flipHorizontal()}
  );
  
  $(".flip_vertical").click(function() {
    PIXEL.flipVertical()
  });
  
  $(".copy").click(function() {
    copyFrameIndex = PIXEL.getCurrentFrameId();
  });
  
  $(".paste").click(function() {
    PIXEL.copyFrameAt(copyFrameIndex);
  });
  
  $(".rotate").click(function() {
    PIXEL.rotate()
  });
});