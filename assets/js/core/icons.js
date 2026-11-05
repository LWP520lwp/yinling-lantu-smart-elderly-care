/* ==========================================================================
   图标库：统一 24×24 线性图标，stroke 1.6，随文字颜色变化
   使用方式：静态标记 <span data-icon="users"></span> 或 JS 中 YL.icon('users')
   ========================================================================== */
(function (global) {
  'use strict';

  var PATHS = {
    dashboard: 'M4 4h6.5v6.5H4zM13.5 4H20v10h-6.5zM4 13.5h6.5V20H4zM13.5 17H20v3h-6.5z',
    users: 'M16 20v-1.6a3.6 3.6 0 0 0-3.6-3.6H6.6A3.6 3.6 0 0 0 3 18.4V20M9.5 11.2a3.9 3.9 0 1 0 0-7.8 3.9 3.9 0 0 0 0 7.8M21 20v-1.6a3.6 3.6 0 0 0-2.7-3.49M16.2 3.6a3.6 3.6 0 0 1 0 6.98',
    user: 'M19 20v-1.6a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4V20M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
    watch: 'M9 3h6M9 21h6M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2ZM12 10v2.4l1.6.9',
    alert: 'M12 9.2v4M12 16.8h.01M10.3 3.9 2.2 17.7A1.8 1.8 0 0 0 3.8 20.4h16.4a1.8 1.8 0 0 0 1.6-2.7L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z',
    clipboard: 'M9 2.8h6v3.4H9zM9 4.5H6.8A1.8 1.8 0 0 0 5 6.3v13.9A1.8 1.8 0 0 0 6.8 22h10.4a1.8 1.8 0 0 0 1.8-1.8V6.3a1.8 1.8 0 0 0-1.8-1.8H15M8.5 11h7M8.5 15.5h4.6',
    chart: 'M4 20V4M4 20h16M7.5 16v-5M12 16V6.5M16.5 16v-3.2',
    spark: 'M11.2 3.2l1.55 4.2 4.2 1.55-4.2 1.55-1.55 4.2-1.55-4.2-4.2-1.55 4.2-1.55 1.55-4.2ZM18.6 15.2l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8.8-2.1Z',
    settings: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM11.6 3.2h.8l.5 2.4 1.7.9 2.3-.9.6.6-.9 2.3.9 1.7 2.4.5v.8l-2.4.5-.9 1.7.9 2.3-.6.6-2.3-.9-1.7.9-.5 2.4h-.8l-.5-2.4-1.7-.9-2.3.9-.6-.6.9-2.3-.9-1.7-2.4-.5v-.8l2.4-.5.9-1.7-.9-2.3.6-.6 2.3.9 1.7-.9.5-2.4Z',
    logout: 'M9 21H5.8A1.8 1.8 0 0 1 4 19.2V4.8A1.8 1.8 0 0 1 5.8 3H9M16 16.5 20.5 12 16 7.5M20.5 12H9.5',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.4-4.4',
    bell: 'M18 8.4a6 6 0 1 0-12 0c0 6.4-2.6 8.1-2.6 8.1h17.2S18 14.8 18 8.4M13.7 20.4a2 2 0 0 1-3.4 0',
    volume: 'M11 5.2 6.6 8.8H3.4v6.4h3.2L11 18.8V5.2ZM15 9.2a4 4 0 0 1 0 5.6M17.8 6.4a8 8 0 0 1 0 11.2',
    'volume-off': 'M11 5.2 6.6 8.8H3.4v6.4h3.2L11 18.8V5.2ZM16 10l4 4M20 10l-4 4',
    chevron: 'm6 9 6 6 6-6',
    'chevron-right': 'm9 6 6 6-6 6',
    plus: 'M12 5v14M5 12h14',
    edit: 'M4 20h4.2L20 8.2a2 2 0 0 0 0-2.8l-1.4-1.4a2 2 0 0 0-2.8 0L4 15.8V20ZM15.5 6.5l2 2',
    unlink: 'M10 14 6.6 17.4a3.4 3.4 0 0 1-4.8-4.8L5.2 9.2M14 10l3.4-3.4a3.4 3.4 0 0 1 4.8 4.8L18.8 14.8M8.5 12h7',
    phone: 'M6.5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2A16.5 16.5 0 0 1 4.5 5.5a2 2 0 0 1 2-2Z',
    'map-pin': 'M20 10.5c0 5.5-8 11-8 11s-8-5.5-8-11a8 8 0 1 1 16 0ZM12 13.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7.5V12l3 1.8',
    upload: 'M12 16V4M7.5 8.5 12 4l4.5 4.5M4 16.5v2A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-2',
    download: 'M12 4v12M7.5 11.5 12 16l4.5-4.5M4 16.5v2A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-2',
    refresh: 'M20.5 12a8.5 8.5 0 1 1-2.6-6.1M20.5 4.5V10h-5.5',
    x: 'M6 6l12 12M18 6 6 18',
    check: 'M4.5 12.5 9.5 17.5 20 7',
    'check-circle': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM8 12.2l2.8 2.8L16.2 9.6',
    'alert-circle': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 8v5M12 16.5h.01',
    info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 11v5M12 7.5h.01',
    'arrow-right': 'M4 12h15M13.5 6.5 20 12l-6.5 5.5',
    'arrow-left': 'M20 12H5M10.5 6.5 4 12l6.5 5.5',
    filter: 'M3.5 5.5h17l-6.5 7.6V19l-4 2v-7.9L3.5 5.5Z',
    shield: 'M12 3 4.5 6v6c0 4.6 3.2 7.6 7.5 9 4.3-1.4 7.5-4.4 7.5-9V6L12 3ZM8.8 12.2l2.2 2.2 4.4-4.6',
    cloud: 'M7 18.5a4 4 0 0 1-.5-8 5.6 5.6 0 0 1 10.8-1.2A3.9 3.9 0 0 1 17.5 18.5H7Z',
    lock: 'M6 10.5h12a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 18 20.5H6A1.5 1.5 0 0 1 4.5 19v-7A1.5 1.5 0 0 1 6 10.5ZM8 10.5V7a4 4 0 0 1 8 0v3.5M12 14.5v3',
    eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'eye-off': 'M4 4l16 16M9.9 5.9A9.6 9.6 0 0 1 12 5.7c6 0 9.5 6.3 9.5 6.3a16 16 0 0 1-2.4 3.3M6.4 7.9A16.6 16.6 0 0 0 2.5 12s3.5 6.3 9.5 6.3a9 9 0 0 0 4-.9M9.9 10a3 3 0 0 0 4.2 4.2',
    calendar: 'M4 6.5h16v13.5H4zM4 10.5h16M8 3.5v4M16 3.5v4',
    menu: 'M4 7h16M4 12h16M4 17h16',
    activity: 'M3 12h4l2.5-6 4 12L16 12h5',
    heart: 'M12 20.2S4 15.5 4 9.8A4.2 4.2 0 0 1 12 7.6a4.2 4.2 0 0 1 8 2.2c0 5.7-8 10.4-8 10.4Z',
    droplet: 'M12 3.5s5.5 5.6 5.5 9.6a5.5 5.5 0 1 1-11 0C6.5 9.1 12 3.5 12 3.5Z',
    home: 'M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1v-9.5Z',
    trash: 'M4 7h16M9 7V4.5h6V7M6 7l1 13h10l1-13M10 11v5.5M14 11v5.5',
    'file-text': 'M6 3.5h7L19 9v11.5H6V3.5ZM13 3.5V9h6M9 13h7M9 16.5h5',
    send: 'M21 3 10.5 13.5M21 3l-6.5 18-4-8-8-4L21 3Z',
    star: 'M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8L12 3.8Z',
    camera: 'M4 8.5h3l1.5-2.5h7L17 8.5h3v11H4v-11ZM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
    wifi: 'M3 9.5a13 13 0 0 1 18 0M6.5 13a8.5 8.5 0 0 1 11 0M9.5 16.5a4 4 0 0 1 5 0M12 20h.01',
    battery: 'M3 8h15v8H3zM18 10.5h2.5v3H18M6 10.5v3M9 10.5v3',
    cpu: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
    database: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3ZM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
    'trend-up': 'M4 16l5-5 3.5 3.5L20 7M15 7h5v5',
    'trend-down': 'M4 8l5 5 3.5-3.5L20 17M15 17h5v-5',
    target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM12 11.6a.4.4 0 1 0 0 .8.4.4 0 0 0 0-.8Z',
    layers: 'M12 3 3 8l9 5 9-5-9-5ZM3 12l9 5 9-5M3 16l9 5 9-5',
    globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3.5 9h17M3.5 15h17M12 3c2.5 2.4 4 5.6 4 9s-1.5 6.6-4 9c-2.5-2.4-4-5.6-4-9s1.5-6.6 4-9Z',
    route: 'M6.5 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM17.5 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM19 6.5h-8.5a4 4 0 0 0 0 8h2a3 3 0 0 1 0 6H8'
  };

  var FILLED = { star: true };

  function iconSvg(name) {
    var d = PATHS[name] || PATHS.info;
    if (FILLED[name]) {
      return '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true" focusable="false"><path d="' + d + '"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="' + d + '"/></svg>';
  }

  function icon(name, cls) {
    return '<span class="ico' + (cls ? ' ' + cls : '') + '">' + iconSvg(name) + '</span>';
  }

  function hydrate(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll('[data-icon]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.getAttribute('data-icon-done') === '1') continue;
      el.innerHTML = iconSvg(el.getAttribute('data-icon'));
      el.setAttribute('data-icon-done', '1');
      if (el.classList.contains('ico') === false) el.classList.add('ico');
    }
  }

  global.YL = global.YL || {};
  global.YL.icon = icon;
  global.YL.iconSvg = iconSvg;
  global.YL.hydrateIcons = hydrate;
  global.YL.iconNames = Object.keys(PATHS);
})(window);