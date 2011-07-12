var currentColor = "#000000";

function postUploadCallback(data) {
  if(typeof data.thumb != 'undefined') {
    $("#images").prepend(data.thumb);
    
    for(var i = 0; i < 2; i++) {
      pixel.setCurrentFrame(i);
      pixel.clearCanvas();
    }
    $(".frame.active").toggleClass("active");
    $(".frame:eq(0)").toggleClass("active");
    pixel.setCurrentFrame(0);
    pixel.clearCanvas();

    // add event tracking data
    _gaq.push(['_trackEvent', 'Drawings', 'Save', data.url]);
      
    FB.ui({
      method: 'feed',
      name: 'My brand new drawing',
      link: data.share_url,
      picture: data.url,
      caption: 'Check my drawing out!',
      description: 'Do you like it?',
      message: 'Check my drawing out!',
      actions: [{name: 'Draw!', link: 'http://drawbang.com/'}]
    },
    function(response) {
      if (response && response.post_id) {
        // alert('Post was published.');

        // add event tracking data
        _gaq.push(['_trackEvent', 'Drawings', 'Post', data.url]);
      } else {
        // alert('Post was not published.');
      }
    });
  }
  else {
    alert(data);
  }
}

function performUpload() {
  var data = {image: null};
  if(pixel.getFrame(1) != null) {
    // NOTE: workaround
    pixel.setCurrentFrame((pixel.getCurrentFrameId()+1)%2);
    pixel.setCurrentFrame((pixel.getCurrentFrameId()+1)%2);
    
    data['image'] = {frames: []};
    for(var i = 0; i < 2; i++) {
      if(pixel.getCurrentFrameId() == i) {
        data['image']['frames'].push(pixel.getCurrentFrame());
      }
      else {
        data['image']['frames'].push(pixel.getFrame(i));
      }
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

$(document).ready(function() {
  var canvas = $("#canvas canvas"),
      zKey = 90;

  pixel.init(canvas[0]);

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
    currentColor = $(".color.active").data().color;
    if($(".action.selectable.active").data().action != "clearPixel") {
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
    pixel.setAction($(this).data().action);
    
    $(".action.selectable.active").toggleClass("active");
    $(this).toggleClass("active");
  });

  // colors
  $(".color").click(function() {
    currentColor = $(this).data().color;
    
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
    pixel.setCurrentFrame($(this).data().frame);
    
    $(".frame.active").toggleClass("active");
    $(this).toggleClass("active");
  });
  
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
  
  $(".play_stop").click(function() {
    if($(this).hasClass("stop")) {
      pixel.stop();
    }
    else {
      pixel.play(5, function(frame) {
        $(".frame.active").toggleClass("active");
        $(".frame").each(function() {
          $(this).data().frame == frame && $(this).toggleClass("active");
        });
      });
    }
    
    $(this).toggleClass("stop");
  });
});