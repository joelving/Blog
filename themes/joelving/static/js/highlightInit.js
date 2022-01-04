$(document).ready(function() {
    hljs.configure({ classPrefix: '', useBR: false, ignoreUnescapedHTML: true });
    $('pre.code-highlight > code, pre > code').each(function(i, block) {
      if (!$(this).hasClass('codeblock')) {
        $(this).addClass('codeblock');
      }
      hljs.highlightBlock(block);
    });
  });