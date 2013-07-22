var currentColor = "#000000",
    copyFrameIndex = -1,
    tips = true;

function postUploadCallback(data) {
  if(typeof data.thumb != 'undefined') {
    $("#images").prepend(data.thumb);
    
    clearAll();
    trackEvent('Save', data.url);
    postDrawAction(data.share_url);
    showFacebookDialog(data.share_url, data.url);
  }
  else {
    trackEvent('Error', data);
  }
}

function performUpload() {
  var data = PIXEL.toObject();

  PIXEL.log(data);

  if(typeof parentId != 'undefined') {
    data['parent'] = parentId;
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
  
  disable($("#upload")).unbind('click');
  disable($("#clear"));
}

function upload() {
  if(confirm("Want to save?")) {
    if(typeof userUid != 'undefined') {
      performUpload();
    }
    else {
      tryingToSave = true;
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
  var framesLength = PIXEL.getFramesLength();
  for(var i = framesLength-1; i >= 0; i--) {
    PIXEL.log('REMOVE ' + i + ' FRAME OF ' + PIXEL.getFramesLength() + ' FRAMES!');
    PIXEL.clearCanvasAt(i);
    PIXEL.removeFrame(i);
    disable($(".frame[data-frame=" + i + "]"));
  }
  PIXEL.setCurrentFrame(0);

  deactivate($(".frame.active"));
  activate($(".frame[data-frame=0]"));
  enable($(".frame[data-frame=0]"));
  disable($(".remove_frame"));
  enable($(".add_frame"));
  
  copyFrameIndex = -1;
}

// deactivate element
function deactivate($el) {
  return $el.removeClass("active");
}

// activate element
function activate($el) {
  return $el.addClass("active");
}

// disable element
function disable($el) {
  return $el.addClass("disabled");
}

// enable element
function enable($el) {
  return $el.removeClass("disabled");
}

// is element enabled?
function isEnabled($el) {
  return $el.size() > 0 && !$el.hasClass("disabled");
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
    message: 'My new awesome pixel art!',
    actions: [{name: 'Fork this drawing!', link: (share_url + '/fork')}]
  },
  function(response) {
    if (response && response.post_id) {
      trackEvent('Post', image_url);
      showFacebookRequestDialog(share_url, image_url);
    }
  });
}

// show facebook request dialog
function showFacebookRequestDialog(share_url, image_url) {
  FB.ui({
    method: 'apprequests',
    message: 'Would you like to fork my new awesome pixel art?',
    title: 'Draw pixel art with your friends',
    data: share_url
  },
  function(response) {
    if (response && response.to) {
      trackEvent('Request', image_url);
    }
  });
}

function postDrawAction(share_url) {
  FB.api(
    '/me/drawbang:draw',
    'post',
    { drawing: share_url },
    function(response) {
      if (!response || response.error) {
        console && console.log(response);
      }
    }
  );
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
  
  PIXEL.doAction(coordinates.x, coordinates.y, currentColor);
  
  if(!isEnabled($("#upload"))) {
    enable($("#upload")).bind('click', upload);
    enable($("#clear"));
  }
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

// play/stop event
function playStop() {
  if($(".play_stop").hasClass("stop")) {
    PIXEL.stop();
  }
  else {
    PIXEL.play(5, function(frame) {
      deactivate($(".frame.active"));
      $(".frame").each(function() {
        $(this).data('frame') == frame && activate($(this));
      });
    });
  }
  
  $(".play_stop").toggleClass("stop");
}

// add frame event
function addFrame() {
  if(isEnabled($(".add_frame"))) {
    PIXEL.setCurrentFrame(PIXEL.getFramesLength());
    maxFrames == PIXEL.getFramesLength() && disable($(".add_frame"));
    enable($(".remove_frame"));
    
    enable($(".frame[data-frame=" + (PIXEL.getFramesLength()-1) + "]"));
    $(".frame.active").toggleClass("active");
    $(".frame[data-frame=" + (PIXEL.getFramesLength()-1) + "]").toggleClass("active");
    
    PIXEL.log(['add_frame', PIXEL.getFramesLength()]);
  }
}

// remove frame event
function removeFrame() {
  if(isEnabled($(".remove_frame"))) {
    PIXEL.clearCanvasAt(PIXEL.getFramesLength()-1);
    PIXEL.removeFrame(PIXEL.getFramesLength()-1);
    PIXEL.setCurrentFrame(PIXEL.getFramesLength()-1);

    1 == PIXEL.getFramesLength() && disable($(".remove_frame"));
    enable($(".add_frame"));
    
    disable($(".frame[data-frame=" + PIXEL.getFramesLength() + "]"));
    $(".frame.active").toggleClass("active");
    $(".frame[data-frame=" + (PIXEL.getFramesLength()-1) + "]").toggleClass("active");
    
    PIXEL.log(['remove_frame, done', PIXEL.getFramesLength()]);
  }
}

// set frame event
function setFrame(index) {
  if(isEnabled($(".frame[data-frame=" + index + "]"))) {
    PIXEL.setCurrentFrame(index);
  
    deactivate($(".frame.active"));
    activate($(".frame[data-frame=" + index + "]"));
  }
}

$(document).ready(function() {
  var canvas = $("#canvas canvas"),
      previewCanvases = $('.frames canvas'),
      zKey = 90,          // undo
      cKey = 67,          // copy
      vKey = 86,          // paste
      eKey = 69,          // eraser
      bKey = 66,          // brush
      gKey = 71,          // bucket
      sKey = 83,          // save
      rightArrowKey = 39, // move right
      upArrowKey = 38,    // move up
      spaceBarKey = 32,   // play/stop
      commaKey = 188,     // remove frame
      markKey = 190,      // add frame
      pageUpKey = 33,     // next frame
      pageDownKey = 34;   // previous frame


  if(typeof imageData != 'undefined') {
    PIXEL.init(canvas[0], previewCanvases, !productionEnv, imageData);

    if(imageData.length > 1) {
      maxFrames == PIXEL.getFramesLength() && disable($(".add_frame"));
      PIXEL.getFramesLength() > 1 && enable($(".remove_frame"));
      
      for(var i = 1; i < PIXEL.getFramesLength(); i++) {
        enable($(".frame[data-frame=" + i + "]"));
      }
    }
  }
  else {
    PIXEL.init(canvas[0], previewCanvases, !productionEnv);
  }

  // set drawing on mousedown
  canvas.mousedown(mouseDownCallback).mousemove(mouseMoveCallback);
  canvas.bind('touchstart', mouseDownCallback).bind('touchmove', mouseMoveCallback);

  // reset drawing on mouseup
  $(document).mouseup(mouseUpCallback);
  $(document).bind('touchend', mouseUpCallback);

  // controls
  $("#clear").click(function() {
    if(isEnabled($("#upload")) && confirm("Sure?")) {
      clearAll();
      disable($("#upload")).unbind('click');
      disable($("#clear"));
    }
  });

  $(".action.selectable").click(function() {
    PIXEL.setAction($(this).data('action'));
    
    deactivate($(".action.selectable.active"));
    activate($(this));
  });

  // colors
  $(".color").click(function() {
    currentColor = $(this).data('color');
    
    deactivate($(".color.active"));
    activate($(this));
  });

  // undo
  $(".undo").click(function() {
    PIXEL.undo();
  });
  
  // frame click
  $(".frame").click(function() {
    setFrame($(this).data('frame'));
  });
  
  $(".add_frame").click(addFrame);
  
  $(".remove_frame").click(removeFrame);
  
  $(".play_stop").click(playStop);
  
  $(".move_right").click(function() {
    PIXEL.moveRight();
  });
  
  $(".move_top").click(function() {
    PIXEL.moveTop();
  });
  
  $(".flip_horizontal").click(function() {
    PIXEL.flipHorizontal();
  });
  
  $(".flip_vertical").click(function() {
    PIXEL.flipVertical();
  });
  
  // copy
  $(".copy").click(function() {
    copyFrameIndex = PIXEL.getCurrentFrameId();
  });
  
  $(".paste").click(function() {
    if(copyFrameIndex > -1 && copyFrameIndex < PIXEL.getFramesLength()) {
      PIXEL.pasteFrameAt(copyFrameIndex);
    }
  });
  
  $(".rotate").click(function() {
    PIXEL.rotate();
  });

  // key bindings
  $(document).keydown(function(e) {
    if(ctrlKey(e)) {
      switch(e.keyCode) {
        case zKey:
          PIXEL.undo();
          return false;
        case cKey:
          copyFrameIndex = PIXEL.getCurrentFrameId();
          return false;
        case vKey:
          if(copyFrameIndex > -1 && copyFrameIndex < PIXEL.getFramesLength()) {
            PIXEL.pasteFrameAt(copyFrameIndex);
          }
          return false;
        case sKey:
          isEnabled($("#upload")) && upload();
          return false;
      }
    }

    switch(e.keyCode) {
      case bKey:
        PIXEL.setAction('pixel');
        deactivate($(".action.selectable.active"));
        activate($(".action.selectable.pixel"));
        return false;
      case gKey:
        PIXEL.setAction('fill');
        deactivate($(".action.selectable.active"));
        activate($(".action.selectable.fill"));
        return false;
      case eKey:
        PIXEL.setAction('clearPixel');
        deactivate($(".action.selectable.active"));
        activate($(".action.selectable.clearPixel"));
        return false;
      case upArrowKey:
        PIXEL.moveTop();
        return false;
      case rightArrowKey:
        PIXEL.moveRight();
        return false;
      case spaceBarKey:
        playStop();
        return false;
      case commaKey:
        removeFrame();
        return false;
      case markKey:
        addFrame();
        return false;
      case pageUpKey:
        setFrame(PIXEL.getCurrentFrameId()-1);
        return false;
      case pageDownKey:
        setFrame(PIXEL.getCurrentFrameId()+1);
        return false;
    }
  });

  // tips
  $("#toggle_tips").change(function() {
    tips = $(this).is(':checked');
  });

  $.each([
    '.pixel',
    '.fill',
    '.clearPixel',
    '.copy',
    '.paste',
    '.undo',
    '.move_top',
    '.move_right',
    '.flip_horizontal',
    '.flip_vertical',
    '.rotate',
    '.play_stop',
    '.frames',
    '.remove_frame',
    '.add_frame',
    '#upload',
    '#clear'
  ], function(i, selector) {
    $(selector).tipsy({
      gravity: 'nw',
      title: function() {
        if(tips) {
          return this.getAttribute('original-title');
        }
        else {
          return '';
        }
      }
    });
  });
});