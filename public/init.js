function upload() {
  $.post('/upload', { imageData : pixel.getDataURL() }, function(data) {
    if(typeof data.thumb != 'undefined') {
      $("#images").prepend(data.thumb);
      pixel.clearCanvas();
      
      console.log(data);
      
      FB.ui({
        method: 'feed',
        name: 'My brand new drawing',
        link: data.share_url,
        picture: data.url,
        caption: 'Check my drawing out!',
        description: 'Do you like it?',
        message: 'Check my drawing out!',
        actions: [JSON.stringify({name: 'Draw!', link: 'http://draw.heroku.com/'})]
      },
      function(response) {
        if (response && response.post_id) {
          // alert('Post was published.');
        } else {
          // alert('Post was not published.');
        }
      });
    }
    else {
      alert(data);
    }
  }, "json");
  
  $(this).unbind('click').removeClass('enabled');
  $(this).addClass('disabled');
  
  return false;
}

$(document).ready(function() {
  var canvas = $("#canvas canvas");

  pixel.init(canvas[0]);

  //set it true on mousedown
  canvas.mousedown(function(e) {
    pixel.setDraw(true);
    var x = e.offsetX ? e.offsetX : e.pageX - this.offsetLeft;
    var y = e.offsetY ? e.offsetY : e.pageY - this.offsetTop;
    
    pixel.doAction(x, y);
    
    $("#upload.disabled").bind('click', upload).removeClass('disabled');
    $("#upload").addClass('enabled');
  }).mousemove(function(e) {
    var x = e.offsetX ? e.offsetX : e.pageX - this.offsetLeft;
    var y = e.offsetY ? e.offsetY : e.pageY - this.offsetTop;
    
    pixel.doAction(x, y);
  });

  //reset it on mouseup
  $(document).mouseup(function() {
    pixel.setDraw(false);
  });
  
  // if shift is pressed set color to transparent
  $(document).keydown(function(e) {
    if(e.keyCode == 16) {
      pixel.setPixelStyle("rgba(0, 0, 0, 0)");
      $("#clear").addClass('active');
    }
  });
  
  // reset color to current active color
  $(document).keyup(function(e) {
    pixel.setPixelStyle($(".color.active").data().color);
    $("#clear").removeClass('active');
  });

  // controls
  $("#clear").click(function() {
    if($("#upload").hasClass('enabled') && confirm("Sure?")) {
      pixel.clearCanvas();
    
      $("#upload.enabled").unbind('click').removeClass('enabled');
      $("#upload").addClass('disabled');
    }
  });

  $(".action").click(function() {
    pixel.setAction($(this).data().action);
    
    $(".action.active").toggleClass("active");
    $(this).toggleClass("active");
  });

  $(".color").click(function() {
    pixel.setPixelStyle($(this).data().color);
    
    $(".color.active").toggleClass("active");
    $(this).toggleClass("active");
  });
});