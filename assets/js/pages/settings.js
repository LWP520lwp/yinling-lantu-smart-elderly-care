/* ==========================================================================
   页面 9：系统设置 / 个人中心 / 角色权限 / 基础配置
   ========================================================================== */
(function (global) {
  'use strict';
  var YL = global.YL;
  var U = YL.utils;
  var UI = YL.ui;
  var S = YL.store;
  var D = YL.data;

  var state = { tab: 'profile' };

  var TABS = [
    { key: 'profile', label: '个人资料', icon: 'user' },
    { key: 'security', label: '安全设置', icon: 'lock' },
    { key: 'accounts', label: '账号管理', icon: 'users', admin: true },
    { key: 'roles', label: '角色权限', icon: 'shield', admin: true },
    { key: 'threshold', label: '告警阈值', icon: 'alert', admin: true },
    { key: 'packages', label: '服务套餐', icon: 'layers', admin: true },
    { key: 'villages', label: '村居与机构', icon: 'map-pin', admin: true },
    { key: 'logs', label: '操作日志', icon: 'file-text', admin: true }
  ];

  function render(container, route) {
    var isAdmin = S.can('settings:manage');
    var tabs = TABS.filter(function (t) { return !t.admin || isAdmin; });
    var wanted = route && route.query.tab;
    if (wanted && tabs.some(function (t) { return t.key === wanted; })) state.tab = wanted;
    if (!tabs.some(function (t) { return t.key === state.tab; })) state.tab = 'profile';

    container.innerHTML =
      '<div class="page page-settings">' +
        '<div class="page-head">' +
          '<div><h2>系统设置</h2>' +
            '<p>' + (isAdmin ? '管理平台账号、角色权限、告警阈值与基础配置。' : '管理个人资料与账号安全。') + '</p></div>' +
          '<div class="page-actions">' +
            '<span class="pill ' + (isAdmin ? 'pill-brand' : '') + '">' + YL.icon(isAdmin ? 'shield' : 'user') +
              (isAdmin ? '超级管理员' : '社区社工') + '</span>' +
          '</div>' +
        '</div>' +

        '<div class="settings-layout">' +
          '<aside class="settings-nav card">' +
            tabs.map(function (t) {
              return '<button type="button" class="settings-nav-item' + (state.tab === t.key ? ' active' : '') + '" data-tab="' + t.key + '">' +
                YL.icon(t.icon) + '<span>' + t.label + '</span>' + YL.icon('chevron-right') + '</button>';
            }).join('') +
          '</aside>' +
          '<div class="settings-main" id="settingsPanel"></div>' +
        '</div>' +
      '</div>';

    YL.hydrateIcons(container);
    renderPanel(container);
    bind(container);
  }

  function renderPanel(container) {
    var panel = container.querySelector('#settingsPanel');
    var map = {
      profile: profilePanel,
      security: securityPanel,
      accounts: accountsPanel,
      roles: rolesPanel,
      threshold: thresholdPanel,
      packages: packagesPanel,
      villages: villagesPanel,
      logs: logsPanel
    };
    panel.innerHTML = (map[state.tab] || profilePanel)();
    YL.hydrateIcons(panel);
    if (state.tab === 'threshold') bindThreshold(panel);
    if (state.tab === 'accounts') bindAccounts(panel, container);
    if (state.tab === 'roles') bindRoles(panel);
    if (state.tab === 'profile') bindProfile(panel);
    if (state.tab === 'security') bindSecurity(panel);
    if (state.tab === 'packages') bindPackages(panel);
    if (state.tab === 'logs') loadLogs(panel);
  }

  /* ------------------------------------------------------------------
     个人资料
     ------------------------------------------------------------------ */
  function profilePanel() {
    var conf = S.roleConf();
    return '<article class="card">' +
      '<div class="card-head"><div class="card-title">' + YL.icon('user') + '个人资料</div>' +
        '<span class="card-sub">账号信息由民政部门统一维护</span></div>' +
      '<div class="card-body">' +
        '<div class="profile-edit-head">' +
          '<span class="avatar avatar-lg">' + conf.name.slice(0, 1) + '</span>' +
          '<div><b>' + U.esc(conf.name) + '</b><p>' + conf.label + ' · ' + conf.desc + '</p>' +
            '<span class="tag tag-brand">' + (S.role() === 'admin' ? '全域数据权限' : conf.scope) + '</span></div>' +
          '<button type="button" class="btn btn-outline btn-sm ml-auto" data-upload-avatar>' + YL.icon('camera') + '更换头像</button>' +
        '</div>' +
        '<div class="divider"></div>' +
        '<form class="form-grid" id="profileForm">' +
          '<div class="field"><label>姓名</label><div class="input-wrap"><input name="name" value="' + U.esc(conf.name) + '"></div></div>' +
          '<div class="field"><label>登录账号</label><div class="input-wrap"><input name="account" value="' + U.esc(conf.account) + '" disabled></div></div>' +
          '<div class="field"><label>手机号码</label><div class="input-wrap"><input name="phone" value="138 0000 2186"></div></div>' +
          '<div class="field"><label>电子邮箱</label><div class="input-wrap"><input name="email" value="linxiaolan@yl-lantu.cn"></div></div>' +
          '<div class="field"><label>所属单位</label><div class="input-wrap"><input name="org" value="平潭综合实验区智慧养老服务中心" disabled></div></div>' +
          '<div class="field"><label>数据范围</label><div class="input-wrap"><input name="scope" value="' + U.esc(conf.scope) + '" disabled></div></div>' +
        '</form>' +
        '<div class="form-actions"><button type="button" class="btn btn-primary" data-save-profile>保存修改</button></div>' +
      '</div>' +
    '</article>';
  }

  function bindProfile(panel) {
    panel.querySelector('[data-upload-avatar]').addEventListener('click', function () {
      UI.toast('演示环境暂不支持头像上传', 'info');
    });
    panel.querySelector('[data-save-profile]').addEventListener('click', function () {
      UI.toast('个人资料已保存', 'success');
    });
  }

  /* ------------------------------------------------------------------
     安全设置
     ------------------------------------------------------------------ */
  function securityPanel() {
    return '<article class="card">' +
      '<div class="card-head"><div class="card-title">' + YL.icon('lock') + '修改登录密码</div></div>' +
      '<div class="card-body">' +
        '<form class="form-stack narrow" id="pwdForm">' +
          '<div class="field"><label>当前密码 <span class="req">*</span></label>' +
            '<div class="input-wrap"><input type="password" name="oldPwd" placeholder="请输入当前密码"></div></div>' +
          '<div class="field"><label>新密码 <span class="req">*</span></label>' +
            '<div class="input-wrap"><input type="password" name="newPwd" placeholder="至少 8 位，包含字母与数字"></div>' +
            '<p class="field-hint">建议每 90 天更换一次密码，不要与其它系统共用。</p></div>' +
          '<div class="field"><label>确认新密码 <span class="req">*</span></label>' +
            '<div class="input-wrap"><input type="password" name="confirmPwd" placeholder="再次输入新密码"></div></div>' +
          '<div class="form-actions"><button type="button" class="btn btn-primary" data-save-pwd>确认修改</button></div>' +
        '</form>' +
        '<div class="divider"></div>' +
        '<div class="security-list">' +
          '<div class="security-row"><div><b>登录保护</b><p>异地登录需短信验证</p></div><button type="button" class="switch on" data-toggle></button></div>' +
          '<div class="security-row"><div><b>操作二次确认</b><p>删除、解绑等敏感操作需二次确认</p></div><button type="button" class="switch on" data-toggle></button></div>' +
          '<div class="security-row"><div><b>最近登录</b><p>' + U.fmtDate(Date.now() - 26 * 60000, 'YYYY-MM-DD HH:mm') + ' · 10.24.8.102 · 平潭</p></div><span class="tag tag-green">当前设备</span></div>' +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function bindSecurity(panel) {
    panel.querySelectorAll('[data-toggle]').forEach(function (sw) {
      sw.addEventListener('click', function () {
        var on = sw.classList.toggle('on');
        sw.setAttribute('aria-pressed', on ? 'true' : 'false');
        UI.toast(on ? '已开启' : '已关闭', 'info', 1600);
      });
    });
    panel.querySelector('[data-save-pwd]').addEventListener('click', function () {
      var form = panel.querySelector('#pwdForm');
      var data = UI.formData(form);
      UI.clearErrors(form);
      if (!data.oldPwd) { UI.fieldError(form, 'oldPwd', '请输入当前密码'); return; }
      if (data.oldPwd !== '123456') { UI.fieldError(form, 'oldPwd', '当前密码不正确（演示密码 123456）'); return; }
      if (!/^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(data.newPwd)) {
        UI.fieldError(form, 'newPwd', '新密码至少 8 位，且包含字母与数字'); return;
      }
      if (data.newPwd !== data.confirmPwd) {
        UI.fieldError(form, 'confirmPwd', '两次输入的新密码不一致'); return;
      }
      form.reset();
      UI.toast('密码修改成功，下次登录请使用新密码', 'success');
    });
  }

  /* ------------------------------------------------------------------
     账号管理
     ------------------------------------------------------------------ */
  function accountsPanel() {
    return '<article class="card">' +
      '<div class="card-head"><div class="card-title">' + YL.icon('users') + '账号管理</div>' +
        '<div class="card-extra"><button type="button" class="btn btn-sm btn-primary" data-add-account>' + YL.icon('plus') + '新增账号</button></div></div>' +
      '<div class="table-wrap">' +
        '<table class="tbl"><thead><tr>' +
          '<th>姓名</th><th>登录账号</th><th>角色</th><th>数据范围</th><th>状态</th><th>最后登录</th><th class="col-actions">操作</th>' +
        '</tr></thead><tbody>' +
        D.ACCOUNTS.map(function (a) {
          return '<tr>' +
            '<td><div class="person"><span class="avatar avatar-sm x-slate">' + a.name.slice(0, 1) + '</span>' +
              '<span class="person-name">' + U.esc(a.name) + '</span></div></td>' +
            '<td class="mono t-sm">' + U.esc(a.account) + '</td>' +
            '<td>' + '<span class="tag ' + (a.role === 'admin' ? 'tag-brand' : a.role === 'social' ? 'tag-orange' : 'tag-gray') + '">' +
              S.ROLES[a.role].label + '</span></td>' +
            '<td class="t-sm">' + U.esc(a.village) + '</td>' +
            '<td><span class="tag ' + (a.status === 'active' ? 'tag-green' : 'tag-gray') + '">' + (a.status === 'active' ? '启用' : '停用') + '</span></td>' +
            '<td class="t-sm">' + U.relTime(a.lastLogin) + '</td>' +
            '<td class="col-actions">' +
              '<button type="button" class="btn-link" data-reset-pwd="' + a.account + '">重置密码</button>' +
              '<button type="button" class="btn-link" data-toggle-account="' + a.account + '">' + (a.status === 'active' ? '停用' : '启用') + '</button>' +
            '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table>' +
      '</div>' +
    '</article>';
  }

  function bindAccounts(panel, container) {
    panel.querySelector('[data-add-account]').addEventListener('click', function () {
      UI.modal({
        size: 'sm',
        title: '新增账号',
        body:
          '<form id="accForm" class="form-stack">' +
            '<div class="field"><label>姓名 <span class="req">*</span></label><div class="input-wrap"><input name="name" placeholder="真实姓名"></div></div>' +
            '<div class="field"><label>登录账号 <span class="req">*</span></label><div class="input-wrap"><input name="account" placeholder="字母 / 数字组合"></div></div>' +
            '<div class="field"><label>角色 <span class="req">*</span></label><div class="input-wrap select-wrap"><select name="role">' +
              '<option value="social">社区社工</option><option value="family">老人家属</option>' +
            '</select><span class="select-caret" data-icon="chevron"></span></div></div>' +
            '<div class="field"><label>所属村居</label><div class="input-wrap"><input name="village" placeholder="如 流水镇 · 北港村"></div></div>' +
          '</form>',
        footer: '<button type="button" class="btn btn-outline" data-close>取消</button>' +
          '<button type="button" class="btn btn-primary" data-create-acc>创建账号</button>',
        onMount: function (api, overlay) {
          YL.hydrateIcons(overlay);
          overlay.querySelector('[data-create-acc]').addEventListener('click', function () {
            var form = overlay.querySelector('#accForm');
            var data = UI.formData(form);
            if (!data.name || !data.account) {
              UI.toast('请填写姓名与登录账号', 'warn');
              return;
            }
            // 登录账号唯一性校验
            var duplicated = D.ACCOUNTS.some(function (a) { return a.account === data.account; });
            if (duplicated) { UI.toast('登录账号 ' + data.account + ' 已存在', 'warn'); return; }

            S.addAccount({
              name: data.name,
              account: data.account,
              role: data.role,
              phone: '',
              village: data.village || '未分配村居'
            });
            UI.toast('账号 ' + data.account + ' 已创建，初始密码将通过短信发送', 'success');
            api.close();
            renderPanel(container);
          });
        }
      });
    });

    panel.querySelectorAll('[data-reset-pwd]').forEach(function (b) {
      b.addEventListener('click', function () {
        UI.confirm({
          title: '重置该账号密码？',
          message: '将为账号 ' + b.getAttribute('data-reset-pwd') + ' 生成随机密码，并通过短信发送给本人。',
          okText: '确认重置'
        }).then(function (ok) {
          if (ok) UI.toast('密码已重置，已发送短信通知', 'success');
        });
      });
    });

    panel.querySelectorAll('[data-toggle-account]').forEach(function (b) {
      b.addEventListener('click', function () {
        var acc = b.getAttribute('data-toggle-account');
        var target = D.ACCOUNTS.filter(function (a) { return a.account === acc; })[0];
        if (!target) return;
        if (acc === 'admin') { UI.toast('超级管理员账号不可停用', 'warn'); return; }
        UI.confirm({
          title: target.status === 'active' ? '停用该账号？' : '启用该账号？',
          message: '账号：' + acc + '（' + target.name + '）',
          danger: target.status === 'active',
          okText: target.status === 'active' ? '停用' : '启用'
        }).then(function (ok) {
          if (!ok) return;
          target.status = target.status === 'active' ? 'disabled' : 'active';
          UI.toast('账号状态已更新', 'success');
          renderPanel(container);
        });
      });
    });
  }

  /* ------------------------------------------------------------------
     角色权限
     ------------------------------------------------------------------ */
  function rolesPanel() {
    var perms = [
      ['系统总览', '查看全域运营数据与实时告警', 1, 1, 0],
      ['老人档案', '查询、新增、编辑老人档案', 1, 1, 1],
      ['智能设备', '设备监控、远程设置与解绑', 1, 1, 0],
      ['应急告警', '告警接收、处置与闭环记录', 1, 1, 1],
      ['服务工单', '创建、派单、结案与评价', 1, 1, 1],
      ['数据报表', '统计报表查看与导出', 1, 0, 0],
      ['AI 健康分析', '调用盘古大模型生成健康建议', 1, 1, 0],
      ['系统设置', '账号、权限与基础配置', 1, 0, 0]
    ];
    return '<article class="card">' +
      '<div class="card-head"><div class="card-title">' + YL.icon('shield') + '角色权限矩阵</div>' +
        '<span class="card-sub">权限变更实时生效</span></div>' +
      '<div class="table-wrap">' +
        '<table class="tbl perm-table"><thead><tr>' +
          '<th>功能模块</th><th>超级管理员</th><th>社区社工</th><th>老人家属</th>' +
        '</tr></thead><tbody>' +
        perms.map(function (p) {
          return '<tr>' +
            '<td><div class="cell-strong">' + p[0] + '</div><div class="t-xs t3">' + p[1] + '</div></td>' +
            [p[2], p[3], p[4]].map(function (v) {
              return '<td>' + (v ?
                '<span class="perm-yes">' + YL.icon('check') + '</span>' :
                '<span class="perm-no">' + YL.icon('x') + '</span>') + '</td>';
            }).join('') +
          '</tr>';
        }).join('') +
        '</tbody></table>' +
      '</div>' +
      '<div class="card-body">' +
        '<div class="info-note">' + YL.icon('info') +
          '<span>社工仅可查看所属乡镇（流水镇）的老人、设备、告警与工单；家属仅可查看绑定老人的健康数据与服务记录。</span></div>' +
      '</div>' +
    '</article>';
  }

  function bindRoles(panel) {
    // 权限矩阵为只读展示，避免演示时误改
  }

  /* ------------------------------------------------------------------
     告警阈值
     ------------------------------------------------------------------ */
  function thresholdPanel() {
    var t = S.state.thresholds;
    return '<article class="card">' +
      '<div class="card-head"><div class="card-title">' + YL.icon('alert') + '告警阈值设置</div>' +
        '<span class="card-sub">修改后对手环实时生效</span></div>' +
      '<div class="card-body">' +
        '<form class="form-grid" id="thresholdForm">' +
          '<div class="field"><label>心率上限（bpm）</label><div class="input-wrap"><input type="number" name="hrHigh" value="' + t.hrHigh + '"></div>' +
            '<p class="field-hint">静息心率持续高于该值触发告警</p></div>' +
          '<div class="field"><label>心率下限（bpm）</label><div class="input-wrap"><input type="number" name="hrLow" value="' + t.hrLow + '"></div>' +
            '<p class="field-hint">低于该值触发心动过缓提醒</p></div>' +
          '<div class="field"><label>血氧下限（%）</label><div class="input-wrap"><input type="number" name="spo2Low" value="' + t.spo2Low + '"></div>' +
            '<p class="field-hint">低于该值触发血氧过低告警</p></div>' +
          '<div class="field"><label>收缩压上限（mmHg）</label><div class="input-wrap"><input type="number" name="sbpHigh" value="' + t.sbpHigh + '"></div>' +
            '<p class="field-hint">连续两次超过该值触发血压异常</p></div>' +
          '<div class="field"><label>跌倒检测灵敏度</label><div class="input-wrap select-wrap"><select name="fallSensitivity">' +
            ['高', '中', '低'].map(function (v) { return '<option' + (v === t.fallSensitivity ? ' selected' : '') + '>' + v + '</option>'; }).join('') +
          '</select><span class="select-caret" data-icon="chevron"></span></div></div>' +
          '<div class="field"><label>电子围栏半径（米）</label><div class="input-wrap"><input type="number" name="fenceRadius" value="' + t.fenceRadius + '"></div></div>' +
          '<div class="field span-2"><label>SOS 紧急号码</label><div class="input-wrap"><input name="sosNumber" value="' + U.esc(t.sosNumber) + '"></div>' +
            '<p class="field-hint">老人长按手环侧键 3 秒自动拨打该号码</p></div>' +
        '</form>' +
        '<div class="info-note mt-4">' + YL.icon('shield') +
          '<span>阈值通过华为云 IoT 设备影子下发，设备离线时将在恢复联网后自动同步。</span></div>' +
        '<div class="form-actions"><button type="button" class="btn btn-outline" data-reset-threshold>恢复默认</button>' +
          '<button type="button" class="btn btn-primary" data-save-threshold>保存并下发</button></div>' +
      '</div>' +
    '</article>';
  }

  function bindThreshold(panel) {
    panel.querySelector('[data-save-threshold]').addEventListener('click', function () {
      var form = panel.querySelector('#thresholdForm');
      var data = UI.formData(form);
      var nums = ['hrHigh', 'hrLow', 'spo2Low', 'sbpHigh', 'fenceRadius'];
      for (var i = 0; i < nums.length; i++) {
        if (!data[nums[i]] || isNaN(Number(data[nums[i]]))) {
          UI.fieldError(form, nums[i], '请输入有效数值');
          return;
        }
      }
      S.setThresholds({
        hrHigh: Number(data.hrHigh), hrLow: Number(data.hrLow),
        spo2Low: Number(data.spo2Low), sbpHigh: Number(data.sbpHigh),
        fallSensitivity: data.fallSensitivity, fenceRadius: Number(data.fenceRadius),
        sosNumber: data.sosNumber
      });
      UI.toast('告警阈值已保存并下发至 1,245 台设备', 'success');
    });

    panel.querySelector('[data-reset-threshold]').addEventListener('click', function () {
      UI.confirm({
        title: '恢复默认阈值？',
        message: '将心率上限恢复为 105 bpm、血氧下限 92%、电子围栏 800 米。',
        okText: '恢复默认'
      }).then(function (ok) {
        if (!ok) return;
        S.setThresholds({ hrHigh: 105, hrLow: 50, spo2Low: 92, sbpHigh: 150, fenceRadius: 800, fallSensitivity: '高' });
        renderPanel(document.getElementById('view'));
        UI.toast('已恢复默认阈值', 'success');
      });
    });
  }

  /* ------------------------------------------------------------------
     服务套餐
     ------------------------------------------------------------------ */
  function packagesPanel() {
    return '<article class="card">' +
      '<div class="card-head"><div class="card-title">' + YL.icon('layers') + '服务套餐配置</div>' +
        '<span class="card-sub">阶梯式会员服务</span></div>' +
      '<div class="card-body">' +
        '<div class="package-grid">' +
          S.state.packages.map(function (p, i) {
            return '<div class="package-card' + (p.key === 'kanghu' ? ' featured' : '') + '">' +
              '<div class="package-head"><b>' + p.name + '</b>' + (p.key === 'kanghu' ? '<span class="tag tag-orange">主推</span>' : '') + '</div>' +
              '<div class="package-price"><span>¥</span><b class="num">' + p.price + '</b><em>/ ' + p.period + '</em></div>' +
              '<ul class="package-list">' + p.services.map(function (s) {
                return '<li>' + YL.icon('check') + s + '</li>';
              }).join('') + '</ul>' +
              '<div class="package-foot"><span>在用 ' + [512, 386, 252, 118][i] + ' 人</span>' +
                '<button type="button" class="btn-link" data-edit-package="' + p.key + '">编辑</button></div>' +
            '</div>';
          }).join('') +
        '</div>' +
        '<div class="info-note mt-4">' + YL.icon('info') +
          '<span>兜底免费套餐由财政全额保障，面向低保、特困与失能兜底对象，不可修改价格。</span></div>' +
      '</div>' +
    '</article>';
  }

  function bindPackages(panel) {
    panel.querySelectorAll('[data-edit-package]').forEach(function (b) {
      b.addEventListener('click', function () {
        var key = b.getAttribute('data-edit-package');
        var pkg = S.state.packages.filter(function (p) { return p.key === key; })[0];
        if (!pkg) return;
        if (key === 'free') { UI.toast('兜底免费套餐由财政定价，不可修改', 'warn'); return; }
        UI.modal({
          size: 'sm',
          title: '编辑套餐 · ' + pkg.name,
          body: '<div class="form-stack">' +
            '<div class="field"><label>套餐价格（元 / 年）</label><div class="input-wrap"><input id="pkgPrice" type="number" value="' + pkg.price + '"></div></div>' +
            '<div class="field"><label>服务内容</label><textarea class="ta" id="pkgServices">' + U.esc(pkg.services.join('\n')) + '</textarea></div>' +
          '</div>',
          footer: '<button type="button" class="btn btn-outline" data-close>取消</button>' +
            '<button type="button" class="btn btn-primary" data-save-pkg>保存</button>',
          onMount: function (api, overlay) {
            overlay.querySelector('[data-save-pkg]').addEventListener('click', function () {
              pkg.price = Number(overlay.querySelector('#pkgPrice').value) || pkg.price;
              pkg.services = overlay.querySelector('#pkgServices').value.split('\n').filter(Boolean);
              api.close();
              UI.toast('套餐配置已更新', 'success');
              renderPanel(document.getElementById('view'));
            });
          }
        });
      });
    });
  }

  /* ------------------------------------------------------------------
     村居与机构
     ------------------------------------------------------------------ */
  function villagesPanel() {
    return '<article class="card">' +
      '<div class="card-head"><div class="card-title">' + YL.icon('map-pin') + '村居信息维护</div>' +
        '<span class="card-sub">42 个合作村居</span></div>' +
      '<div class="table-wrap" style="max-height:340px;overflow-y:auto">' +
        '<table class="tbl tbl-sm"><thead><tr><th>村居</th><th>所属乡镇</th><th>在册老人</th><th>服务老人</th><th>覆盖率</th><th>合作机构</th></tr></thead><tbody>' +
        D.VILLAGES.slice(0, 20).map(function (v) {
          return '<tr><td class="cell-strong">' + U.esc(v.name) + '</td><td class="t-sm">' + v.town + '</td>' +
            '<td class="cell-num">' + v.registered + '</td><td class="cell-num">' + v.total + '</td>' +
            '<td class="cell-num">' + v.rate.toFixed(1) + '%</td><td class="t-sm">' + v.orgs + ' 家</td></tr>';
        }).join('') + '</tbody></table>' +
      '</div>' +
      '<div class="card-body"><span class="t-xs t3">仅展示前 20 个村居，完整清单可在数据报表中导出。</span></div>' +
    '</article>' +
    '<article class="card mt-4">' +
      '<div class="card-head"><div class="card-title">' + YL.icon('home') + '养老机构</div>' +
        '<span class="card-sub">12 家合作机构</span></div>' +
      '<div class="table-wrap">' +
        '<table class="tbl tbl-sm"><thead><tr><th>机构名称</th><th>类型</th><th>所在村居</th><th>床位数</th><th>联系电话</th></tr></thead><tbody>' +
        D.ORGS.map(function (o) {
          return '<tr><td class="cell-strong">' + U.esc(o.name) + '</td><td><span class="tag tag-outline">' + o.type + '</span></td>' +
            '<td class="t-sm">' + U.esc(o.village) + '</td><td class="cell-num">' + o.beds + '</td>' +
            '<td class="mono t-sm">' + U.esc(o.contact) + '</td></tr>';
        }).join('') + '</tbody></table>' +
      '</div>' +
    '</article>';
  }

  /* ------------------------------------------------------------------
     操作日志
     ------------------------------------------------------------------ */
  var LOG_LIMIT = 100;        // 单次拉取的审计条数
  var LOG_TIMEOUT = 2500;     // 审计接口超时阈值（毫秒），超时即降级
  var LOG_DETAIL_MAX = 40;    // detail 文本截断长度

  // 审计 action 到中文文案的映射，未收录的动作直接展示原始标识
  var LOG_ACTION_TEXT = {
    login: '登录系统',
    logout: '退出登录',
    ai_chat: 'AI 健康问答',
    alert_handle: '处置告警',
    alert_false_alarm: '标记告警误报',
    elder_view: '查看老人档案',
    elder_export: '导出老人档案',
    report_export: '导出数据报表',
    device_command: '下发设备指令'
  };

  // 敏感动作在列表中打「敏感」标签，与 mock LOGS 的 level 语义保持一致
  var LOG_SENSITIVE = {
    login: 1, logout: 1, alert_handle: 1, alert_false_alarm: 1,
    elder_export: 1, report_export: 1, device_command: 1
  };

  // 不进入展示文本的敏感字段名
  var LOG_SECRET_KEY = /password|passwd|pwd|token|secret|credential|access_?key|secret_?key/i;

  // 日志请求序号：只接受最后一次请求的响应，丢弃切换 Tab / 重渲染后的过期结果
  var logRequestSeq = 0;

  function isList(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  }

  /** detail 转简短文本：字符串直接用，对象按 k=v 拼接，敏感字段剔除，过长截断 */
  function logDetailText(detail) {
    if (detail === null || detail === undefined || detail === '') return '';
    var text;
    if (typeof detail === 'string') {
      text = detail;
    } else if (typeof detail === 'object') {
      var parts = [];
      for (var k in detail) {
        if (!Object.prototype.hasOwnProperty.call(detail, k)) continue;
        if (LOG_SECRET_KEY.test(k)) continue;
        var v = detail[k];
        if (v === null || v === undefined) continue;
        parts.push(k + '=' + (typeof v === 'object' ? '[对象]' : String(v)));
      }
      text = parts.join('; ');
    } else {
      text = String(detail);
    }
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > LOG_DETAIL_MAX ? text.slice(0, LOG_DETAIL_MAX) + '…' : text;
  }

  /** 审计记录 → 现有 LOGS 字段（time / user / action / ip / level） */
  function mapAuditLog(item) {
    var rec = item || {};
    var ts = Number(rec.ts);
    // 后端 ts 为秒级时间戳，兼容毫秒输入；非法值退回当前时间
    if (!isFinite(ts) || ts <= 0) ts = Date.now();
    else if (ts < 1e11) ts = ts * 1000;

    var label = LOG_ACTION_TEXT[rec.action] || rec.action || '未知操作';
    if (rec.target_id) label += ' ' + String(rec.target_id);
    var detail = logDetailText(rec.detail);
    if (detail) label += '（' + detail + '）';

    var sensitive = !!(LOG_SENSITIVE[rec.action] || (rec.result && rec.result !== 'ok'));
    return {
      time: ts,
      user: rec.actor_name || rec.actor_id || '系统',
      action: label,
      ip: rec.ip || '—',
      level: sensitive ? 'warn' : 'info'
    };
  }

  /** 判断响应是否为可识别的日志列表结构，避免把异常响应误判成「无记录」 */
  function isAuditPayload(data) {
    if (!data) return false;
    return isList(data) || isList(data.items) || isList(data.logs);
  }

  /** 兼容 { items: [] } / { logs: [] } / 裸数组三种返回结构 */
  function pickAuditItems(data) {
    if (!data) return [];
    if (isList(data)) return data;
    if (isList(data.items)) return data.items;
    if (isList(data.logs)) return data.logs;
    return [];
  }

  /** 组装 Bearer 鉴权头；无 token 时按未登录处理，不阻断请求 */
  function logAuthHeaders() {
    var headers = { Accept: 'application/json' };
    try {
      var token = S && typeof S.token === 'function' ? S.token() : '';
      if (token) headers.Authorization = 'Bearer ' + token;
    } catch (e) {
      /* 读取失败按未登录处理 */
    }
    return headers;
  }

  /**
   * 拉取审计日志：2.5 秒超时（AbortController + 定时器双保险），
   * 任何失败统一 reject，由调用方回退 mock 数据，不产生未捕获异常
   */
  function requestAuditLogs() {
    return new Promise(function (resolve, reject) {
      var api = YL.api;
      if (!api || typeof global.fetch !== 'function') {
        reject(new Error('审计接口不可用'));
        return;
      }

      var controller = global.AbortController ? new global.AbortController() : null;
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        if (controller) { try { controller.abort(); } catch (e) { /* ignore */ } }
        reject(new Error('审计服务响应超时'));
      }, LOG_TIMEOUT);

      function settle(fn, arg) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      }

      var options = { method: 'GET', headers: logAuthHeaders() };
      if (controller) options.signal = controller.signal;

      var pending;
      try {
        pending = global.fetch((api.API_BASE || '') + '/api/audit/logs?limit=' + LOG_LIMIT, options);
      } catch (e) {
        settle(reject, new Error('审计请求发起失败'));
        return;
      }

      pending.then(function (res) {
        if (!res || !res.ok) {
          settle(reject, new Error('审计接口返回异常'));
          return null;
        }
        return res.json();
      }).then(function (data) {
        settle(resolve, data);
      }).catch(function (err) {
        // 超时已 abort 并 reject，此处不重复上报
        if (err && err.name === 'AbortError') return;
        settle(reject, err || new Error('审计接口调用失败'));
      });
    });
  }

  /** 单行日志渲染，字段与 mock LOGS 保持一致 */
  function logRowHtml(l) {
    return '<tr>' +
      '<td class="mono t-sm">' + U.fmtDate(l.time, 'MM-DD HH:mm:ss') + '</td>' +
      '<td class="cell-strong">' + U.esc(l.user) + '</td>' +
      '<td class="t-sm">' + U.esc(l.action) + '</td>' +
      '<td class="mono t-xs t3">' + U.esc(l.ip) + '</td>' +
      '<td>' + (l.level === 'warn' ? '<span class="tag tag-orange">敏感</span>' : '<span class="tag tag-gray">常规</span>') + '</td>' +
    '</tr>';
  }

  /** 数据源状态：loading 请求中 / real 真实数据（含空列表）/ mock 降级演示数据 */
  var LOG_SOURCE = { LOADING: 'loading', REAL: 'real', MOCK: 'mock' };

  /**
   * 写入日志表体；面板已切换（节点脱离文档）时返回 false，避免误改
   * emptyText 为空列表（或加载中）时的占位文案
   */
  function renderLogRows(panel, list, emptyText) {
    var tbody = panel.querySelector('#logRows');
    if (!tbody || !tbody.parentNode) return false;
    var rows = list && list.length ? list.map(logRowHtml).join('') :
      '<tr><td colspan="5" class="t-sm t3">' + (emptyText || '暂无操作日志记录') + '</td></tr>';
    tbody.innerHTML = rows;
    return true;
  }

  /** 降级标注只在 mock 数据模式下显示；loading / real 一律隐藏 */
  function toggleLogNote(panel, state) {
    var note = panel.querySelector('#logSourceNote');
    if (note) note.style.display = state === LOG_SOURCE.MOCK ? '' : 'none';
  }

  /**
   * 按数据源状态渲染日志表：表体与降级标注在同一次同步更新内完成，
   * 不存在「展示演示数据却不显示标注」的时间窗
   * - loading：只显示加载占位，绝不渲染 mock；
   * - real：渲染真实数据，空列表显示空状态并隐藏标注；
   * - mock：渲染演示数据，同时显示「当前为演示数据」标注。
   */
  function applyLogState(panel, state, list) {
    var rows = list || [];
    var emptyText;
    if (state === LOG_SOURCE.LOADING) {
      rows = [];
      emptyText = '正在加载审计日志…';
    } else if (state === LOG_SOURCE.REAL) {
      emptyText = '暂无审计记录';
    } else {
      emptyText = '暂无操作日志记录';
    }
    if (!renderLogRows(panel, rows, emptyText)) return false;
    toggleLogNote(panel, state);
    return true;
  }

  /**
   * 优先请求真实审计日志，按三种状态渲染：
   * 请求中 → 加载占位；成功（含空列表）→ 真实数据 / 空状态；
   * 失败、超时、API 不可用 → 回退 mock 并显示降级标注。
   * 全程不弹错误提示。
   */
  function loadLogs(panel) {
    var fallback = D.LOGS || [];
    var seq = ++logRequestSeq;
    // 请求期间只展示加载占位，避免把演示数据当作真实日志呈现
    applyLogState(panel, LOG_SOURCE.LOADING, null);

    requestAuditLogs().then(function (data) {
      if (seq !== logRequestSeq) return;   // 已切换 Tab 或重新渲染，丢弃过期响应
      if (!isAuditPayload(data)) {
        // 200 但返回结构不可识别，按接口不可用处理
        applyLogState(panel, LOG_SOURCE.MOCK, fallback);
        return;
      }
      var list = pickAuditItems(data).map(mapAuditLog);
      // 接口成功：空列表是真实结果，渲染空状态，不回退 mock
      applyLogState(panel, LOG_SOURCE.REAL, list);
    }).catch(function () {
      if (seq !== logRequestSeq) return;
      // 失败 / 超时 / API 不可用：回退演示数据并显示降级标注
      applyLogState(panel, LOG_SOURCE.MOCK, fallback);
    });
  }

  function logsPanel() {
    return '<article class="card">' +
      '<div class="card-head"><div class="card-title">' + YL.icon('file-text') + '操作日志</div>' +
        '<span class="card-sub">记录敏感操作</span></div>' +
      '<div class="table-wrap">' +
        '<table class="tbl"><thead><tr><th>时间</th><th>操作人</th><th>操作内容</th><th>IP / 来源</th><th>级别</th></tr></thead>' +
        '<tbody id="logRows"><tr><td colspan="5" class="t-sm t3">正在加载审计日志…</td></tr></tbody></table>' +
      '</div>' +
      '<div class="card-body" id="logSourceNote" style="display:none">' +
        '<span class="t-xs t3">当前为演示数据（审计服务未连接）</span></div>' +
    '</article>';
  }

  function bind(container) {
    container.querySelectorAll('.settings-nav-item').forEach(function (b) {
      b.addEventListener('click', function () {
        state.tab = b.getAttribute('data-tab');
        container.querySelectorAll('.settings-nav-item').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        renderPanel(container);
      });
    });
  }

  YL.pages = YL.pages || {};
  YL.pages.settings = { render: render };
})(window);