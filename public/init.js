function upload() {
  $.post('/upload', { imageData : pixel.getDataURL() }, function(response) {
    if(response.match(/\d+\.png/)) {
      $("#images").prepend(response);
    }
    else {
      alert(response);
    }
  });
  
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
    e.keyCode == 16 && console.log("shift!");
    e.keyCode == 16 && pixel.setPixelStyle("rgba(0, 0, 0, 0)");
  });
  
  // reset color to current active color
  $(document).keyup(function(e) {
    pixel.setPixelStyle($(".color.active").data().color);
  });

  // controls
  $("#clear").click(function() {
    pixel.clearCanvas();
    
    $("#upload.enabled").unbind('click').removeClass('enabled');
    $("#upload").addClass('disabled');
    
    return false;
  });

  $(".action").click(function() {
    pixel.setAction($(this).data().action);
    
    $(".action.active").toggleClass("active");
    $(this).toggleClass("active");
    
    return false;
  });

  $(".color").click(function() {
    pixel.setPixelStyle($(this).data().color);
    
    $(".color.active").toggleClass("active");
    $(this).toggleClass("active");
    
    return false;
  });
});