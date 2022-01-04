window.onload = updateMinWidth;
window.onresize = updateMinWidth;
document.getElementById("sidebar").addEventListener("transitionend", updateMinWidth);
function updateMinWidth() {
  var sidebar = document.getElementById("sidebar");
  var main = document.getElementById("main");
  main.style.minWidth = "";
  var w1 = getComputedStyle(main).getPropertyValue("min-width");
  var w2 = getComputedStyle(sidebar).getPropertyValue("width");
  var w3 = getComputedStyle(sidebar).getPropertyValue("left");
  main.style.minWidth = `calc(${w1} - ${w2} - ${w3})`;
}