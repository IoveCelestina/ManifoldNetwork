/* Manifold 移动端设计稿交互（CSP 友好：无内联脚本/onclick，全部 addEventListener）*/
(function () {
  const app = document.getElementById('app');
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const setDrawer = (v) => app.classList.toggle('drawer-open', v);
  const setSheet = (v) => app.classList.toggle('sheet-open', v);

  function applyMode(isImage) {
    app.classList.toggle('mode-image', isImage);
    $('.thread-chat').classList.toggle('hidden', isImage);
    $('.thread-image').classList.toggle('hidden', !isImage);
    $('#ta').placeholder = isImage ? '描述你想生成的画面…' : '输入消息…';
    $('#model-pill').classList.toggle('is-image', isImage);
    $('#pv-chat').classList.toggle('on', !isImage);
    $('#pv-image').classList.toggle('on', isImage);
  }

  // 顶栏 / 抽屉 / 弹层 开关（用 data-action 绑定，避免内联 onclick）
  $$('[data-action]').forEach((el) => {
    el.addEventListener('click', () => {
      switch (el.dataset.action) {
        case 'drawer-open': setDrawer(true); break;
        case 'drawer-close': setDrawer(false); break;
        case 'sheet-open': setSheet(true); break;
        case 'sheet-close': setSheet(false); break;
        case 'preview-chat': applyMode(false); break;
        case 'preview-image': applyMode(true); break;
      }
    });
  });

  // 模型选择
  $$('.mdl').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.model;
      const isImage = btn.dataset.kind === 'image';
      $('#model-name').textContent = name;
      $$('.mdl').forEach((b) => b.classList.remove('sel'));
      btn.classList.add('sel');
      applyMode(isImage);
      setSheet(false);
    });
  });

  // textarea 自动长高
  const ta = $('#ta');
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  });
})();
