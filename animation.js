(function() {
  function runAnimation() {
    const h1 = document.querySelector('h1');
    if (!h1 || h1.dataset.animated === "true") return;
    h1.dataset.animated = "true";
    h1.classList.add('hero-anim');
  }

  const checkExist = setInterval(() => {
    if (document.querySelector('h1')) {
      clearInterval(checkExist);
      runAnimation();
    }
  }, 200);
})();