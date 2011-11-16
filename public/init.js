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
    if(pixel.getFrame(i) == null) {
      lastFrameNotNull = i-1;
      lastFrameNotNullFound = true;
    }
  }
  
  console.log(['lastFrameNotNull', lastFrameNotNull]);
  
  if(0 != lastFrameNotNull) {
    -1 == lastFrameNotNull && (lastFrameNotNull = 15);
    
    // NOTE: workaround to populate frames matrix
    for(var i = 0; i < lastFrameNotNull+1; i++) {
      pixel.setCurrentFrame((pixel.getCurrentFrameId()+1) % (lastFrameNotNull+1));
    }
    
    data['image'] = {frames: []};
    for(var i = 0; i < lastFrameNotNull+1; i++) {
      data['image']['frames'].push(pixel.getFrame(i));
    }
  }
  else {
    data['image'] = {frame: pixel.getCurrentFrame()};
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
    pixel.setCurrentFrame(i);
    pixel.clearCanvas();
    disable($(".frame[data-frame=" + i + "]"));
  }
  deactivate($(".frame.active"));
  activate($(".frame[data-frame=0]"));
  enable($(".frame[data-frame=0]"));
  pixel.setCurrentFrame(0);
  pixel.clearCanvas();
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

$(document).ready(function() {
  var canvas = $("#canvas canvas"),
      zKey = 90;

  pixel.init(canvas[0], !production_env);

  //set it true on mousedown
  canvas.mousedown(function(e) {
    pixel.setDraw(true);
    var x = e.offsetX ? e.offsetX : e.pageX - this.offsetLeft;
    var y = e.offsetY ? e.offsetY : e.pageY - this.offsetTop;
    
    pixel.doAction(x, y, currentColor);
    
    $("#upload.disabled").bind('click', upload).removeClass('disabled');
    $("#upload").addClass('enabled');
  }).mousemove(function(e) {
    var x = e.offsetX ? e.offsetX : e.pageX - this.offsetLeft;
    var y = e.offsetY ? e.offsetY : e.pageY - this.offsetTop;
    
    pixel.doAction(x, y, currentColor);
  });

  //reset it on mouseup
  $(document).mouseup(function() {
    pixel.setDraw(false);
  });
  
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
      pixel.clearCanvas();
    
      $("#upload.enabled").unbind('click').removeClass('enabled');
      $("#upload").addClass('disabled');
    }
  });

  $(".action.selectable").click(function() {
    pixel.setAction($(this).data('action'));
    
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
        pixel.redo();
      }
      else {
        pixel.undo();
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
      pixel.setCurrentFrame($(this).data('frame'));
    
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
      
      pixel.setCurrentFrame(frames-1);
      
      console.log(['add_frame', frames]);
    }
  });
  
  // remove frame
  $(".remove_frame").click(function() {
    if(isEnabled($(this))) {
      frames--;
      1 == frames && disable($(this));
      enable($(".add_frame"));
      
      disable($(".frame[data-frame=" + frames + "]"));
      $(".frame.active").toggleClass("active");
      $(".frame[data-frame=" + (frames-1) + "]").toggleClass("active");
      
      console.log(['remove_frame', frames]);
    }
  });
  
  // NOTE: deprecated
  /*
  $(".onion").click(function() {
    if($(this).data().frame == pixel.getCurrentOnionFrameId()) {
      pixel.setOnionFrame(null);
    }
    else {
      pixel.setOnionFrame($(this).data().frame);
      $(".onion.active").toggleClass("active");
    }
    
    $(this).toggleClass("active");
  });
  */
  
  $(".play_stop").click(function() {
    if($(this).hasClass("stop")) {
      pixel.stop();
    }
    else {
      pixel.play(5, function(frame) {
        $(".frame.active").toggleClass("active");
        $(".frame").each(function() {
          $(this).data('frame') == frame && $(this).toggleClass("active");
        });
      });
    }
    
    $(this).toggleClass("stop");
  });
});