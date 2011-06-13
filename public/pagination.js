$(document).ready(function() {
  $("#more").click(function() {
    $.get("/?page=" + (currentPage + 1), function(data) {
      currentPage++;
      $("#images").append(data);
    });
    
    return false;
  });
  
  $(window).infinitescroll({
    url: window.location.href,
    triggerAt: 150,
    appendTo: "#images",
    page: currentPage+1
  })
  
  $("#images").bind('infinitescroll.finish', function() {
    currentPage++;
  }).bind('infinitescroll.maxreached', function() {
    $("#more").hide();
  });
});