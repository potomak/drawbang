$(document).ready(function() {
  var canvas = $("#canvas canvas");

  pixel.init(canvas[0]);

  //set it true on mousedown
  canvas.mousedown(function(e) {
    pixel.setDraw(true);
    var x = e.offsetX ? e.offsetX : e.pageX - this.offsetLeft;
    var y = e.offsetY ? e.offsetY : e.pageY - this.offsetTop;
    pixel.doAction(x, y);
  }).mousemove(function(e) {
    var x = e.offsetX ? e.offsetX : e.pageX - this.offsetLeft;
    var y = e.offsetY ? e.offsetY : e.pageY - this.offsetTop;
    pixel.doAction(x, y);
  });

  //reset it on mouseup
  $(document).mouseup(function() {
    pixel.setDraw(false);
  });

  // controls
  $("#clear").click(function() {
    pixel.clearCanvas();
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

  $("#upload").click(function() {
    $.post('/upload', { imageData : pixel.getDataURL() }, function(response) {
      if(response.match(/\d+\.png/)) {
        $("#images").prepend("<img src='/images/" + response + "'>");
      }
      else {
        alert(response);
      }
    });
    return false;
  });
});