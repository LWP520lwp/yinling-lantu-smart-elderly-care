/* ==========================================================================
   登录页交互：验证码 / 密码可见性 / 表单校验 / 角色填充
   ========================================================================== */
(function (global) {
  'use strict';
  var YL = global.YL;
  var U = YL.utils;
  var UI = YL.ui;

  var captchaCode = '';
  var onSuccess = null;

  var CHARS = 'ABCDEFGHJKLMNPQRSTUVWXY23456789';
  var COLORS = ['#165DFF', '#0B3FCC', '#4E5969', '#C25E00', '#009A23'];

  /**
   * 大赛演示口令：仅用于页面下方演示 chip 的快速填充与离线演示。
   * 真实校验全部交给后端 YL.api.login，前端不再比对任何口令。
   * 正式环境应删除演示入口（含本常量）。
   */
  var DEMO_PASSWORD = '123456';

  function rand(n) { return Math.floor(Math.random() * n); }

  function renderCaptcha() {
    var svg = document.getElementById('captchaSvg');
    if (!svg) return;
    captchaCode = '';
    for (var i = 0; i < 4; i++) captchaCode += CHARS.charAt(rand(CHARS.length));

    var parts = [];
    // 背景干扰线
    for (var l = 0; l < 3; l++) {
      var y1 = rand(40), y2 = rand(40);
      parts.push('<path d="M0 ' + y1 + ' Q28 ' + rand(40) + ' 56 ' + rand(40) + ' T112 ' + y2 + '" fill="none" stroke="' +
        COLORS[rand(COLORS.length)] + '" stroke-opacity=".18" stroke-width="1"/>');
    }
    // 噪点
    for (var d = 0; d < 14; d++) {
      parts.push('<circle cx="' + rand(112) + '" cy="' + rand(40) + '" r="1" fill="#B9C1CE" opacity=".5"/>');
    }
    // 字符
    for (var i2 = 0; i2 < 4; i2++) {
      var x = 12 + i2 * 24 + rand(4);
      var y = 27 + rand(5) - 3;
      var deg = rand(30) - 15;
      var color = COLORS[rand(COLORS.length)];
      parts.push('<text x="' + x + '" y="' + y + '" transform="rotate(' + deg + ' ' + x + ' ' + y + ')"' +
        ' font-family="Bahnschrift, Consolas, monospace" font-size="21" font-weight="700" fill="' + color + '"' +
        ' letter-spacing="1">' + captchaCode.charAt(i2) + '</text>');
    }
    svg.innerHTML = parts.join('');
  }

  function setError(name, message) {
    var err = document.getElementById('err' + name);
    if (err) {
      if (message) {
        err.innerHTML = YL.icon('alert-circle') + '<span>' + U.esc(message) + '</span>';
        err.hidden = false;
      } else {
        err.hidden = true;
      }
    }
    var field = document.getElementById(name === 'Account' ? 'loginAccount' : name === 'Password' ? 'loginPassword' : 'loginCaptcha');
    if (field) {
      var wrap = field.closest('.input-wrap');
      if (wrap) wrap.classList.toggle('is-error', !!message);
    }
  }

  function clearAllErrors() {
    ['Account', 'Password', 'Captcha'].forEach(function (n) { setError(n, ''); });
    var box = document.getElementById('authError');
    if (box) box.hidden = true;
  }

  function showAuthError(message) {
    var box = document.getElementById('authError');
    if (!box) return;
    box.innerHTML = YL.icon('alert-circle') + '<span>' + U.esc(message) + '</span>';
    box.hidden = false;
  }

  function setLoading(loading) {
    var btn = document.getElementById('loginBtn');
    if (!btn) return;
    btn.disabled = loading;
    btn.innerHTML = loading
      ? '<span class="spinner"></span><span class="btn-label">登录中</span>'
      : '<span class="btn-label">登录</span>';
  }

  /**
   * 网络不可用 / 认证模块缺失时的降级入口：
   * 写入只读离线演示会话（不携带 token），保证无后端双击打开仍可预览全部页面。
   */
  function enterOfflineDemo(account, role) {
    var roles = YL.store.ROLES || {};
    var conf = roles[role] || {};
    YL.store.login({
      token: '',
      offline: true,
      user: {
        id: '',
        name: conf.name || account,
        account: account,
        role: role,
        scope: role === 'admin' ? '全域' : ''
      }
    });
    setLoading(false);
    renderCaptcha();
    UI.toast('无法连接认证服务，已进入离线演示模式', 'warn', 2600);
    if (onSuccess) onSuccess();
  }

  function submit(e) {
    if (e) e.preventDefault();
    clearAllErrors();

    var account = (document.getElementById('loginAccount').value || '').trim();
    var password = document.getElementById('loginPassword').value || '';
    var captcha = (document.getElementById('loginCaptcha').value || '').trim();
    var role = document.getElementById('loginRole').value;
    var remember = document.getElementById('rememberMe').checked;

    var hasError = false;
    if (!account) { setError('Account', '请输入账号'); hasError = true; }
    if (!password) { setError('Password', '请输入登录密码'); hasError = true; }
    if (!captcha) { setError('Captcha', '请输入验证码'); hasError = true; }
    if (hasError) return;

    if (captcha.toUpperCase() !== captchaCode) {
      setError('Captcha', '验证码不正确，请重新输入');
      document.getElementById('loginCaptcha').value = '';
      renderCaptcha();
      return;
    }

    setLoading(true);

    // 认证统一走后端：账号 / 密码 / 角色 / 状态均由服务端判定，前端不再比对演示口令
    var api = YL.api;
    var request = null;
    if (api && typeof api.login === 'function') {
      try {
        request = api.login(account, password, role);
      } catch (err) {
        request = null;                                 // 同步异常按网络失败降级
      }
    }

    // YL.api 缺失（认证模块未加载）：直接进入离线演示，不抛错、不白屏
    if (!request || typeof request.then !== 'function') {
      enterOfflineDemo(account, role);
      return;
    }

    // 两个回调分开传递：登录成功后的视图切换若抛错，不能被误判为登录失败而转入离线演示
    request.then(function () {
      // 成功时 YL.api.login 内部已写入 YL.store 会话，这里只处理记住账号与视图切换
      // 登录审计由后端 /api/auth/login 内部统一写入，前端不重复上报
      U.store.set('yl_login_hint', remember ? { account: account, role: role } : null);
      setLoading(false);
      if (onSuccess) onSuccess();
    }, function (err) {
      setLoading(false);
      var code = err && err.code;
      if (code === 'INVALID_CREDENTIALS') {
        setError('Password', '账号或密码不正确');
        renderCaptcha();
        return;
      }
      if (code === 'ROLE_MISMATCH') {
        showAuthError('角色与账号不匹配，请切换角色后登录');
        renderCaptcha();
        return;
      }
      if (code === 'ACCOUNT_DISABLED') {
        showAuthError('该账号已被停用，请联系管理员');
        renderCaptcha();
        return;
      }
      if (code === 'TOO_MANY_ATTEMPTS') {
        showAuthError('尝试过于频繁，请稍后再试');
        renderCaptcha();
        return;
      }
      // 网络失败 / 服务端异常：允许进入只读离线演示会话
      enterOfflineDemo(account, role);
    });
  }

  function init(successCb) {
    onSuccess = successCb;

    var form = document.getElementById('loginForm');
    if (!form) return;

    renderCaptcha();
    document.getElementById('captchaBox').addEventListener('click', renderCaptcha);

    document.getElementById('togglePwd').addEventListener('click', function () {
      var input = document.getElementById('loginPassword');
      var showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      this.innerHTML = YL.icon(showing ? 'eye' : 'eye-off');
      this.setAttribute('aria-label', showing ? '显示密码' : '隐藏密码');
      this.title = showing ? '显示密码' : '隐藏密码';
    });

    U.qsa('.demo-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        document.getElementById('loginAccount').value = chip.getAttribute('data-account');
        document.getElementById('loginPassword').value = DEMO_PASSWORD;
        document.getElementById('loginRole').value = chip.getAttribute('data-role');
        clearAllErrors();
        var cap = document.getElementById('loginCaptcha');
        cap.value = '';
        renderCaptcha();
        cap.focus();
        UI.toast('已填入演示账号，请输入右侧验证码', 'info', 2400);
      });
    });

    document.getElementById('forgotPwd').addEventListener('click', function () {
      UI.modal({
        size: 'sm',
        title: '找回登录密码',
        desc: '平台账号由民政部门统一分配',
        body: '<div class="info-note">' + YL.icon('info') +
          '<span>请联系平潭综合实验区智慧养老服务中心管理员（0591-2431 8800）重置密码；也可由所属村居社工提交账号重置工单。</span></div>',
        footer: '<button type="button" class="btn btn-primary" data-close>我知道了</button>'
      });
    });

    form.addEventListener('submit', submit);

    // 输入时清除对应错误
    ['loginAccount', 'loginPassword', 'loginCaptcha'].forEach(function (id) {
      var input = document.getElementById(id);
      input.addEventListener('input', function () {
        var key = id.replace('login', '');
        setError(key, '');
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && id === 'loginCaptcha') {
          e.preventDefault();
          submit();
        }
      });
    });

    // 恢复记住的账号
    var hint = U.store.get('yl_login_hint', null);
    if (hint && hint.account) {
      document.getElementById('loginAccount').value = hint.account;
      document.getElementById('loginRole').value = hint.role || 'admin';
      document.getElementById('rememberMe').checked = true;
    }

    YL.hydrateIcons(document.getElementById('authView'));
  }

  YL.auth = { init: init, refreshCaptcha: renderCaptcha };

  // 页面加载后立即渲染验证码（避免等待 app 启动）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { renderCaptcha(); });
  } else {
    renderCaptcha();
  }
})(window);