/* ==========================================================================
   页面 4：智能设备管理（华为云 IoT 核心体现页）
   ========================================================================== */
(function (global) {
  'use strict';
  var YL = global.YL;
  var U = YL.utils;
  var UI = YL.ui;
  var S = YL.store;
  var D = YL.data;

  /** 老人姓名展示文本：管理员会话显示原文，其余角色一律脱敏（utils.maskName） */
  function maskElderName(name) {
    return U.canSeeRaw() ? (name || '') : U.maskName(name);
  }

  var state = { page: 1, size: 10, q: '', status: '' };
  var logTimer = null;

  /* 详情页实时接入状态：调用方（YL.realtime）通过模块回调写入，切换设备/离开页面后立即失效 */
  var liveContainer = null;   // 当前详情页根节点
  var liveDevice = null;      // 当前详情页设备对象
  var liveDeviceId = '';      // 当前详情页设备编号（已 trim）
  var liveLocation = '';      // 云端帧不含定位，沿用设备村居文案
  var liveToken = 0;          // 绑定序号：每次挂载 +1，旧回调据此自动作废
  var lastFrameKey = '';      // 同一帧可能经 app 转发与本页订阅双路到达，按帧去重

  function deviceStatusTag(status) {
    var d = D.DICT.deviceStatus[status];
    return '<span class="status ' + d.cls + '"><span class="dot"></span>' + d.text + '</span>';
  }

  function batteryCell(v, status) {
    var tone = v <= 20 || status === 'fault' ? 'red' : v <= 45 ? 'orange' : 'green';
    return '<div class="battery"><div class="bar ' + tone + '"><i style="width:' + v + '%"></i></div>' +
      '<span>' + v + '%</span></div>';
  }

  /* ------------------------------------------------------------------
     列表
     ------------------------------------------------------------------ */
  function renderList(container) {
    var summary = D.SUMMARY;
    var devices = S.devices();

    container.innerHTML =
      '<div class="page page-devices">' +
        '<div class="page-head">' +
          '<div><h2>智能设备管理</h2>' +
            '<p>「银龄守护」手环通过华为云 IoT 设备接入服务统一纳管，实时回传心率、定位与跌倒状态。</p></div>' +
          '<div class="page-actions">' +
            '<button type="button" class="btn btn-outline" id="syncDevices">' + YL.icon('refresh') + '同步设备清单</button>' +
            '<button type="button" class="btn btn-primary" id="bindDevice">' + YL.icon('link') + '绑定新设备</button>' +
          '</div>' +
        '</div>' +

        '<div class="metrics metrics-5">' +
          '<div class="metric is-brand"><div class="metric-label">' + YL.icon('watch') + '接入设备总数</div>' +
            '<div class="metric-value">' + U.fmt(summary.deviceTotal) + '<span class="unit">台</span></div>' +
            '<div class="metric-foot">鸿蒙智联认证设备</div></div>' +
          '<div class="metric is-green"><div class="metric-label">在线设备</div>' +
            '<div class="metric-value">' + U.fmt(summary.deviceOnline) + '<span class="unit">台</span></div>' +
            '<div class="metric-foot">在线率 ' + summary.deviceOnlineRate + '%</div></div>' +
          '<div class="metric"><div class="metric-label">离线设备</div>' +
            '<div class="metric-value">' + U.fmt(summary.deviceOffline) + '<span class="unit">台</span></div>' +
            '<div class="metric-foot">含海岛信号盲区</div></div>' +
          '<div class="metric is-red"><div class="metric-label">故障设备</div>' +
            '<div class="metric-value">' + U.fmt(summary.deviceFault) + '<span class="unit">台</span></div>' +
            '<div class="metric-foot">故障率 2.0%</div></div>' +
          '<div class="metric is-orange"><div class="metric-label">今日数据上传量</div>' +
            '<div class="metric-value">186.4<span class="unit">万条</span></div>' +
            '<div class="metric-foot">较昨日 <span class="delta-up">+4.2%</span></div></div>' +
        '</div>' +

        '<section class="iot-banner">' +
          '<div class="iot-banner-icon">' + YL.icon('cloud') + '</div>' +
          '<div class="iot-banner-body">' +
            '<b>华为云 IoT 设备接入服务（IoTDA）</b>' +
            '<p>MQTT 双向通信 · 设备影子 · 端到端加密传输 · OTA 固件升级，单实例支撑万级手环并发接入</p>' +
          '</div>' +
          '<div class="iot-banner-tags">' +
            '<span class="pill pill-brand">' + YL.icon('shield') + '端到端加密</span>' +
            '<span class="pill pill-orange">鸿蒙智联生态</span>' +
            '<span class="pill">设备接入 China East</span>' +
          '</div>' +
        '</section>' +

        '<div class="card table-card">' +
          '<div class="table-toolbar">' +
            '<div class="flex gap-3">' +
              '<div class="input-wrap" style="width:240px">' +
                '<span class="input-ico" data-icon="search"></span>' +
                '<input id="devSearch" placeholder="设备编号 / 老人姓名" value="' + U.esc(state.q) + '">' +
              '</div>' +
              '<div class="segmented" id="devStatusFilter">' +
                '<button type="button" class="' + (!state.status ? 'active' : '') + '" data-status="">全部</button>' +
                '<button type="button" class="' + (state.status === 'online' ? 'active' : '') + '" data-status="online">在线</button>' +
                '<button type="button" class="' + (state.status === 'offline' ? 'active' : '') + '" data-status="offline">离线</button>' +
                '<button type="button" class="' + (state.status === 'fault' ? 'active' : '') + '" data-status="fault">故障</button>' +
              '</div>' +
            '</div>' +
            '<span class="t-sm t3">当前展示重点监测设备 ' + devices.length + ' 台</span>' +
          '</div>' +
          '<div class="table-wrap" id="deviceTable"></div>' +
          '<div id="devicePager"></div>' +
        '</div>' +
      '</div>';

    YL.hydrateIcons(container);
    renderTable(container);
    bindList(container);
  }

  function filtered() {
    return S.devices().filter(function (d) {
      if (state.status && d.status !== state.status) return false;
      if (state.q) {
        var q = state.q.toLowerCase();
        if (d.id.toLowerCase().indexOf(q) === -1 && (d.elderName || '').toLowerCase().indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function renderTable(container) {
    var all = filtered();
    var pages = Math.max(1, Math.ceil(all.length / state.size));
    if (state.page > pages) state.page = pages;
    var rows = all.slice((state.page - 1) * state.size, state.page * state.size);
    var table = container.querySelector('#deviceTable');

    if (!all.length) {
      table.innerHTML = UI.empty('watch', '没有匹配的设备', '调整筛选条件，或同步最新的设备清单。');
      container.querySelector('#devicePager').innerHTML = '';
      return;
    }

    table.innerHTML =
      '<table class="tbl">' +
        '<thead><tr>' +
          '<th>设备编号</th><th>绑定老人</th><th>设备类型</th><th>绑定村居</th>' +
          '<th>在线状态</th><th>最后上报</th><th>电量</th><th class="col-actions">操作</th>' +
        '</tr></thead>' +
        '<tbody>' + rows.map(function (d) {
          return '<tr class="' + (d.status === 'fault' ? 'row-critical' : '') + '">' +
            '<td><div class="mono t-sm cell-strong">' + U.esc(d.id) + '</div>' +
              '<div class="t-xs t3 mono">' + U.esc(d.iotId.slice(0, 16)) + '…</div></td>' +
            '<td>' + (d.elderId ?
              '<a class="link-name" href="#/elders/' + d.elderId + '">' + U.esc(maskElderName(d.elderName)) + '</a>' :
              '<span class="t3 t-sm">未绑定</span>') + '</td>' +
            '<td><span class="t-sm">' + U.esc(d.type) + '</span><div class="t-xs t3">' + U.esc(d.firmware) + '</div></td>' +
            '<td><span class="t-sm">' + U.esc(d.village) + '</span><div class="t-xs t3">' + U.esc(d.town) + '</div></td>' +
            '<td>' + deviceStatusTag(d.status) + '</td>' +
            '<td><span class="t-sm">' + U.relTime(d.lastReport) + '</span>' +
              '<div class="t-xs t3 mono">' + U.fmtDate(d.lastReport, 'HH:mm:ss') + '</div></td>' +
            '<td>' + batteryCell(d.battery, d.status) + '</td>' +
            '<td class="col-actions">' +
              '<button type="button" class="btn-link" data-device-view="' + d.id + '">查看详情</button>' +
              '<button type="button" class="btn-link" data-device-set="' + d.id + '">远程设置</button>' +
              '<button type="button" class="btn-link" data-device-unbind="' + d.id + '">解绑</button>' +
            '</td>' +
          '</tr>';
        }).join('') + '</tbody>' +
      '</table>';

    container.querySelector('#devicePager').innerHTML = UI.pager({ total: all.length, page: state.page, size: state.size });
    YL.hydrateIcons(table);

    table.querySelectorAll('[data-device-view]').forEach(function (b) {
      b.addEventListener('click', function () { YL.router.go('/devices/' + b.getAttribute('data-device-view')); });
    });
    table.querySelectorAll('[data-device-set]').forEach(function (b) {
      b.addEventListener('click', function () { openRemoteSettings(b.getAttribute('data-device-set')); });
    });
    table.querySelectorAll('[data-device-unbind]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-device-unbind');
        var device = S.devices().filter(function (d) { return d.id === id; })[0];
        if (!device || !device.elderId) { UI.toast('该设备当前未绑定老人', 'info'); return; }
        UI.confirm({
          title: '解绑该设备？',
          message: '解绑后设备 ' + id + ' 将停止上报「' + maskElderName(device.elderName) + '」的健康数据，历史数据仍会保留。',
          okText: '确认解绑', danger: true
        }).then(function (ok) {
          if (!ok) return;
          S.unbindDevice(id);
          UI.toast('设备已解绑', 'success');
          renderTable(container);
        });
      });
    });

    UI.bindPager(container.querySelector('#devicePager'), function (page, size) {
      if (size) state.size = size;
      state.page = page;
      renderTable(container);
    });
  }

  function bindList(container) {
    var input = container.querySelector('#devSearch');
    input.addEventListener('input', U.debounce(function () {
      state.q = input.value.trim();
      state.page = 1;
      renderTable(container);
    }, 260));

    container.querySelectorAll('#devStatusFilter [data-status]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        container.querySelectorAll('#devStatusFilter button').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        state.status = btn.getAttribute('data-status');
        state.page = 1;
        renderTable(container);
      });
    });

    container.querySelector('#syncDevices').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" style="border-color:rgba(22,93,255,.25);border-top-color:#165DFF"></span>同步中';
      setTimeout(function () {
        btn.disabled = false;
        btn.innerHTML = YL.icon('refresh') + '同步设备清单';
        UI.toast('设备清单已同步，新增 2 台鸿蒙智联手环', 'success');
      }, 900);
    });

    container.querySelector('#bindDevice').addEventListener('click', function () {
      openBindDevice(container);
    });
  }

  /* ------------------------------------------------------------------
     绑定新设备
     ------------------------------------------------------------------ */
  function openBindDevice(container) {
    var unbound = S.elders().filter(function (e) { return e.deviceBound === false; });
    UI.modal({
      title: '绑定新设备',
      desc: '输入手环背面的设备编号，系统将自动校验华为云 IoT 平台注册状态。',
      body:
        '<form id="bindForm" class="form-grid">' +
          '<div class="field span-2"><label>设备编号 <span class="req">*</span></label>' +
            '<div class="input-wrap"><input name="deviceId" placeholder="如 YL-PT-2024-1088"></div></div>' +
          '<div class="field span-2"><label>绑定老人</label>' +
            '<div class="input-wrap select-wrap"><select name="elderId">' +
              '<option value="">暂不绑定（入库备用）</option>' +
              unbound.map(function (e) {
                return '<option value="' + e.id + '">' + U.esc(maskElderName(e.name)) + ' · ' + U.esc(e.village) + ' · ' + e.id + '</option>';
              }).join('') +
            '</select><span class="select-caret" data-icon="chevron"></span></div></div>' +
          '<div class="info-note span-2">' + YL.icon('shield') +
            '<span>设备将接入华为云 IoT 设备接入服务，采用一机一密认证与 TLS 1.2 端到端加密传输。</span></div>' +
        '</form>',
      footer:
        '<button type="button" class="btn btn-outline" data-close>取消</button>' +
        '<button type="button" class="btn btn-primary" data-bind>校验并绑定</button>',
      onMount: function (api, overlay) {
        YL.hydrateIcons(overlay);
        overlay.querySelector('[data-bind]').addEventListener('click', function () {
          var form = overlay.querySelector('#bindForm');
          var data = UI.formData(form);
          if (!data.deviceId) { UI.fieldError(form, 'deviceId', '请输入设备编号'); return; }
          if (!/^YL-PT-\d{4}-\d{4}$/.test(data.deviceId)) {
            UI.fieldError(form, 'deviceId', '设备编号格式应为 YL-PT-2024-XXXX'); return;
          }
          // 防止重复绑定同一编号设备
          var duplicated = S.devices().some(function (d) { return d.id === data.deviceId; });
          if (duplicated) { UI.fieldError(form, 'deviceId', '该设备已在设备清单中，请勿重复绑定'); return; }

          var patch = { id: data.deviceId };
          if (data.elderId) {
            var elder = S.state.elders.filter(function (e) { return e.id === data.elderId; })[0];
            if (!elder) { UI.toast('老人档案不存在', 'warn'); return; }
            patch.elderId = elder.id;
            patch.elderName = elder.name;
            patch.village = elder.village;
            patch.town = elder.town;
          }

          S.addDevice(patch);
          // 联动老人档案：标记已绑定并回写设备编号
          if (data.elderId) {
            S.updateElder(data.elderId, { deviceBound: true, deviceId: data.deviceId });
          }
          UI.toast('设备 ' + data.deviceId + ' 校验通过，已绑定华为云 IoT 实例', 'success');
          api.close();
          if (container) renderTable(container);
        });
      }
    });
  }

  /* ------------------------------------------------------------------
     远程设置
     ------------------------------------------------------------------ */
  function openRemoteSettings(deviceId) {
    var device = S.devices().filter(function (d) { return d.id === deviceId; })[0];
    if (!device) return;
    UI.drawer({
      title: '远程设置 · ' + device.id,
      desc: '指令经华为云 IoT 平台下发，设备在线时 10 秒内生效。',
      body:
        '<form id="remoteForm" class="form-stack">' +
          '<div class="setting-row"><div><b>用药提醒</b><p>每日 08:00 / 20:00 震动提醒老人服药</p></div>' +
            '<button type="button" class="switch on" data-toggle="medRemind" aria-pressed="true"></button></div>' +
          '<div class="setting-row"><div><b>跌倒自动报警</b><p>检测到跌倒后 30 秒未取消即上报平台</p></div>' +
            '<button type="button" class="switch on" data-toggle="fallAlert" aria-pressed="true"></button></div>' +
          '<div class="setting-row"><div><b>电子围栏</b><p>超出设定范围后触发越界告警</p></div>' +
            '<button type="button" class="switch on" data-toggle="fence" aria-pressed="true"></button></div>' +
          '<div class="field"><label>用药提醒时间</label>' +
            '<div class="input-wrap"><input name="medTime" value="08:00 / 20:00"></div></div>' +
          '<div class="field"><label>SOS 紧急号码</label>' +
            '<div class="input-wrap"><input name="sos" value="' + U.esc(S.state.thresholds.sosNumber) + '"></div></div>' +
          '<div class="field"><label>跌倒检测灵敏度</label>' +
            '<div class="input-wrap select-wrap"><select name="sensitivity">' +
              ['高', '中', '低'].map(function (s) {
                return '<option' + (s === S.state.thresholds.fallSensitivity ? ' selected' : '') + '>' + s + '</option>';
              }).join('') +
            '</select><span class="select-caret" data-icon="chevron"></span></div></div>' +
          '<div class="info-note">' + YL.icon('info') +
            '<span>设备接入：华为云 IoT 设备接入服务，配置指令通过 MQTT 加密通道下发。</span></div>' +
        '</form>',
      footer:
        '<button type="button" class="btn btn-outline" data-close>取消</button>' +
        '<button type="button" class="btn btn-primary" data-save-remote>下发配置</button>',
      onMount: function (api, overlay) {
        YL.hydrateIcons(overlay);
        overlay.querySelectorAll('[data-toggle]').forEach(function (sw) {
          sw.addEventListener('click', function () {
            var on = sw.classList.toggle('on');
            sw.setAttribute('aria-pressed', on ? 'true' : 'false');
          });
        });
        overlay.querySelector('[data-save-remote]').addEventListener('click', function () {
          var data = UI.formData(overlay.querySelector('#remoteForm'));
          S.setThresholds({ sosNumber: data.sos, fallSensitivity: data.sensitivity });
          UI.toast('配置已下发至 ' + device.id + '，预计 10 秒内生效', 'success');
          api.close();
        });
      }
    });
  }

  /* ------------------------------------------------------------------
     设备详情
     ------------------------------------------------------------------ */
  function renderDetail(container, route) {
    var device = S.devices().filter(function (d) { return d.id === route.params.id; })[0];
    if (!device) {
      container.innerHTML = '<div class="page">' + UI.empty('watch', '未找到该设备', '设备可能已解绑或不在当前角色的管理范围内。',
        '<a class="btn btn-primary" href="#/devices">返回设备列表</a>') + '</div>';
      return;
    }
    var elder = device.elderId ? S.state.elders.filter(function (e) { return e.id === device.elderId; })[0] : null;

    container.innerHTML =
      '<div class="page page-device-detail">' +
        '<div class="detail-nav">' +
          '<a class="back-link" href="#/devices">' + YL.icon('arrow-left') + '返回设备列表</a>' +
          '<div class="detail-nav-actions">' +
            '<button type="button" class="btn btn-outline" data-remote>' + YL.icon('settings') + '远程设置</button>' +
            '<button type="button" class="btn btn-primary" data-restart>' + YL.icon('refresh') + '远程重启</button>' +
          '</div>' +
        '</div>' +

        '<section class="device-hero card">' +
          '<div class="device-hero-icon">' + YL.icon('watch') + '</div>' +
          '<div class="device-hero-main">' +
            '<div class="device-hero-title"><h2 class="mono">' + U.esc(device.id) + '</h2>' +
              deviceStatusTag(device.status) +
              '<span class="tag tag-brand">鸿蒙智联</span></div>' +
            '<p class="device-hero-sub">' + U.esc(device.type) + ' · 固件 ' + U.esc(device.firmware) + ' · 激活于 ' + U.fmtDate(device.activatedAt, 'YYYY-MM-DD') + '</p>' +
            '<p class="device-hero-iot">IoT 设备 ID：<span class="mono">' + U.esc(device.iotId) + '</span></p>' +
          '</div>' +
          '<div class="device-hero-stats">' +
            '<div><span>电量</span><b class="num" data-hero-battery>' + device.battery + '%</b></div>' +
            '<div><span>信号</span><b class="num">' + (device.signal ? device.signal + '/4' : '无') + '</b></div>' +
            '<div><span>最后上报</span><b data-hero-report>' + U.relTime(device.lastReport) + '</b></div>' +
          '</div>' +
        '</section>' +

        '<div class="detail-grid">' +
          '<div class="detail-col-side">' +
            '<article class="card">' +
              '<div class="card-head"><div class="card-title">' + YL.icon('cpu') + '设备参数</div></div>' +
              '<div class="card-body">' +
                '<dl class="kv-list">' +
                  '<div><span class="k">设备型号</span><span class="v">' + U.esc(device.type) + '</span></div>' +
                  '<div><span class="k">绑定老人</span><span class="v">' + (elder ?
                    '<a class="link-name" href="#/elders/' + elder.id + '">' + U.esc(maskElderName(elder.name)) + '</a>（' + U.esc(elder.village) + '）' : '<span class="t3">未绑定</span>') + '</span></div>' +
                  '<div><span class="k">IMEI</span><span class="v mono">' + U.esc(device.imei) + '</span></div>' +
                  '<div><span class="k">MAC 地址</span><span class="v mono">' + U.esc(device.mac) + '</span></div>' +
                  '<div><span class="k">固件版本</span><span class="v">' + U.esc(device.firmware) + '</span></div>' +
                  '<div><span class="k">接入区域</span><span class="v">华为云 · 华东-上海一</span></div>' +
                  '<div><span class="k">通信协议</span><span class="v">MQTT 3.1.1 / TLS 1.2</span></div>' +
                '</dl>' +
              '</div>' +
            '</article>' +

            '<article class="card">' +
              '<div class="card-head"><div class="card-title">' + YL.icon('settings') + '远程控制</div></div>' +
              '<div class="card-body remote-actions">' +
                '<button type="button" class="remote-btn" data-remote>' +
                  '<span>' + YL.icon('activity') + '</span><b>用药提醒</b><em>每日 08:00 / 20:00</em></button>' +
                '<button type="button" class="remote-btn" data-sos>' +
                  '<span>' + YL.icon('phone') + '</span><b>SOS 号码</b><em class="mono">' + U.esc(S.state.thresholds.sosNumber) + '</em></button>' +
                '<button type="button" class="remote-btn" data-restart>' +
                  '<span>' + YL.icon('refresh') + '</span><b>远程重启</b><em>10 秒内完成</em></button>' +
                '<button type="button" class="remote-btn" data-remote>' +
                  '<span>' + YL.icon('target') + '</span><b>电子围栏</b><em>半径 800 米</em></button>' +
              '</div>' +
            '</article>' +
          '</div>' +

          '<div class="detail-col-main">' +
            '<article class="card">' +
              '<div class="card-head">' +
                '<div class="card-title">' + YL.icon('database') + '实时数据上报日志</div>' +
                '<div class="card-extra"><span class="live-tag"><span class="live-dot"></span>每 5 秒刷新</span></div>' +
              '</div>' +
              '<div class="table-wrap device-log-wrap">' +
                '<table class="tbl tbl-sm"><thead><tr>' +
                  '<th>上报时间</th><th>心率</th><th>血氧</th><th>步数</th><th>跌倒状态</th><th>定位</th>' +
                '</tr></thead><tbody id="deviceLogBody"></tbody></table>' +
              '</div>' +
            '</article>' +

            '<article class="card iot-security">' +
              '<div class="card-head"><div class="card-title">' + YL.icon('shield') + '数据安全与接入说明</div></div>' +
              '<div class="card-body">' +
                '<div class="security-grid">' +
                  '<div><span class="security-ico">' + YL.icon('lock') + '</span><b>端到端加密</b><p>手环 → IoTDA → 业务平台全链路 TLS 1.2 加密，健康数据落库前脱敏。</p></div>' +
                  '<div><span class="security-ico">' + YL.icon('cpu') + '</span><b>一机一密</b><p>每台设备独立密钥认证，防止伪造设备接入与数据篡改。</p></div>' +
                  '<div><span class="security-ico">' + YL.icon('cloud') + '</span><b>设备影子</b><p>离线期间指令缓存至设备影子，恢复联网后自动补发。</p></div>' +
                '</div>' +
                '<div class="info-note mt-3">' + YL.icon('cloud') +
                  '<span>设备接入：华为云 IoT 设备接入服务，数据端到端加密传输；支持 OTA 固件升级与鸿蒙设备联动。</span></div>' +
              '</div>' +
            '</article>' +
          '</div>' +
        '</div>' +
      '</div>';

    YL.hydrateIcons(container);
    renderLogs(container, device);

    container.querySelector('[data-remote]').addEventListener('click', function () { openRemoteSettings(device.id); });
    container.querySelectorAll('[data-sos]').forEach(function (b) {
      b.addEventListener('click', function () {
        UI.modal({
          size: 'sm',
          title: '配置 SOS 紧急号码',
          desc: '长按手环侧键 3 秒将自动拨打该号码。',
          body: '<div class="field"><label>SOS 号码</label><div class="input-wrap"><input id="sosInput" value="' + U.esc(S.state.thresholds.sosNumber) + '"></div></div>',
          footer: '<button type="button" class="btn btn-outline" data-close>取消</button>' +
            '<button type="button" class="btn btn-primary" data-save-sos>保存并下发</button>',
          onMount: function (api, overlay) {
            overlay.querySelector('[data-save-sos]').addEventListener('click', function () {
              var val = overlay.querySelector('#sosInput').value.trim();
              if (!val) { UI.toast('请输入 SOS 号码', 'warn'); return; }
              S.setThresholds({ sosNumber: val });
              UI.toast('SOS 号码已下发至设备', 'success');
              api.close();
              renderDetail(container, route);
            });
          }
        });
      });
    });
    container.querySelectorAll('[data-restart]').forEach(function (b) {
      b.addEventListener('click', function () {
        UI.confirm({
          title: '下发远程重启指令？',
          message: '设备将在 10 秒内重启，期间健康数据上报会短暂中断。',
          okText: '确认重启'
        }).then(function (ok) {
          if (!ok) return;
          UI.toast('重启指令已下发，设备正在重启…', 'info');
          setTimeout(function () { UI.toast('设备 ' + device.id + ' 已恢复在线', 'success'); }, 2200);
        });
      });
    });
  }

  /* ------------------------------------------------------------------
     实时上报日志：优先真实链路（YL.realtime 体征帧），不可用时回退 5 秒模拟
     ------------------------------------------------------------------ */

  /** 统一帧时间：兼容毫秒 / 秒级时间戳 / 日期字符串，非法值退回当前时间 */
  function liveTimestamp(v) {
    if (v === null || v === undefined || v === '') return Date.now();
    if (typeof v === 'number') return v < 1000000000000 ? v * 1000 : v;
    var str = String(v).trim();
    if (str && /^-?\d+$/.test(str)) {
      var n = Number(str);
      return n < 1000000000000 ? n * 1000 : n;
    }
    var t = new Date(str).getTime();
    return isNaN(t) ? Date.now() : t;
  }

  /** 体征取值兜底：缺失或非数字统一显示为 — */
  function liveValue(v) {
    if (v === null || v === undefined || v === '') return '—';
    return isNaN(Number(v)) ? '—' : v;
  }

  /** 单行日志 HTML：历史行与实时帧共用同一套结构 / 样式类，保证视觉完全一致 */
  function logRowHtml(time, hr, spo2, step, fall, location) {
    return '<td class="mono t-sm">' + U.fmtDate(time, 'HH:mm:ss') + '</td>' +
      '<td class="cell-num">' + U.esc(String(hr)) + ' <span class="t-xs t3">bpm</span></td>' +
      '<td class="cell-num">' + U.esc(String(spo2)) + '%</td>' +
      '<td class="cell-num">' + U.esc(String(step)) + '</td>' +
      '<td>' + (fall ? '<span class="tag tag-red">检测到跌倒</span>' : '<span class="tag tag-green">正常</span>') + '</td>' +
      '<td class="t-sm">' + U.esc(location) + '</td>';
  }

  function renderLogs(container, device) {
    var body = container.querySelector('#deviceLogBody');
    if (!body) return;
    var logs = D.deviceLogs(device);
    body.innerHTML = logs.map(function (l) {
      return '<tr>' + logRowHtml(l.time, l.hr, l.spo2, l.step, l.fall, l.location) + '</tr>';
    }).join('');

    // 优先真实链路；不可用（模块缺失 / 未连接）时回退改造前的 5 秒本地模拟
    if (!startLive(container, device)) startLogTimer(container, device);
  }

  /** 旧实现：5 秒本地模拟上报（仅真实链路不可用时启用，逻辑与节流保持原样） */
  function startLogTimer(container, device) {
    if (logTimer) clearInterval(logTimer);
    var body = container.querySelector('#deviceLogBody');
    if (!body) return;
    logTimer = setInterval(function () {
      if (!document.body.contains(body)) { clearInterval(logTimer); logTimer = null; return; }
      if (document.hidden) return;
      var now = Date.now();
      var tr = document.createElement('tr');
      tr.className = 'log-new';
      tr.innerHTML = logRowHtml(
        now,
        68 + Math.floor(Math.random() * 18),
        95 + Math.floor(Math.random() * 4),
        Math.floor(Math.random() * 180),
        false,
        device.village + ' · 距村部 ' + Math.floor(Math.random() * 600) + ' 米'
      );
      body.insertBefore(tr, body.firstChild);
      while (body.children.length > 12) body.removeChild(body.lastChild);
    }, 5000);
  }

  /** 记录当前详情页的绑定信息，并让上一份绑定（上一台设备 / 上一次渲染）立即失效 */
  function startLiveBinding(container, device) {
    liveContainer = container;
    liveDevice = device;
    liveDeviceId = String(device.id === null || device.id === undefined ? '' : device.id).trim();
    liveLocation = device.village + ' · 实时上报';
    lastFrameKey = '';
    liveToken++;
  }

  /** 挂载实时链路：成功返回 true；模块缺失 / 未连接返回 false，由调用方回退 */
  function startLive(container, device) {
    startLiveBinding(container, device);
    if (!YL.realtime || typeof YL.realtime.start !== 'function') return false;
    var token = liveToken;
    var ok = false;
    try {
      ok = YL.realtime.start({
        onVitals: function (data) { handleVitals(data, token); },
        // 透传全局回调：无论 YL.realtime 采用合并式还是覆盖式注册，告警链路都不会被本页顶掉
        onAlert: function (alert) {
          if (YL.app && typeof YL.app.onLiveAlert === 'function') YL.app.onLiveAlert(alert);
        },
        onOpen: function () {
          // 链路已连通：停掉可能已启动的本地模拟，后续只展示真实体征帧
          if (logTimer) { clearInterval(logTimer); logTimer = null; }
          if (YL.app && typeof YL.app.onLiveOpen === 'function') YL.app.onLiveOpen();
        },
        onUnavailable: function () {
          handleUnavailable(token);
          if (YL.app && typeof YL.app.onLiveUnavailable === 'function') YL.app.onLiveUnavailable();
        }
      }) === true;
    } catch (e) {
      ok = false;
    }
    // 链路可用后停掉可能残留的本地模拟定时器，避免真实行与模拟行混排
    if (ok && logTimer) { clearInterval(logTimer); logTimer = null; }
    return ok;
  }

  /** 真实体征帧：按设备编号过滤后写入日志表格 */
  function handleVitals(data, token) {
    if (!data || !liveContainer || !liveDevice) return;
    if (token !== undefined && token !== liveToken) return;   // 旧页面绑定，已失效
    var cur = String(liveDeviceId).trim().toUpperCase();
    var incoming = String(data.device_id === null || data.device_id === undefined ? '' : data.device_id).trim().toUpperCase();
    if (!cur || cur !== incoming) return;   // 设备编号不一致（忽略大小写与首尾空格）

    var body = liveContainer.querySelector('#deviceLogBody');
    if (!body || !document.body.contains(body)) return;   // 已离开详情页，不再写 DOM

    var ts = liveTimestamp(data.event_time);
    var frameKey = incoming + '|' + ts + '|' + liveValue(data.hr);
    // 同一帧可能经 app.js 转交与本页订阅双路到达，按“设备 + 时间 + 心率”去重
    if (frameKey === lastFrameKey) return;
    lastFrameKey = frameKey;

    var fall = data.fall === true || data.fall === 1 || data.fall === 'true' || data.fall === '1';
    var tr = document.createElement('tr');
    tr.className = 'log-new';
    tr.innerHTML = logRowHtml(ts, liveValue(data.hr), liveValue(data.spo2), liveValue(data.steps), fall, liveLocation);
    body.insertBefore(tr, body.firstChild);
    while (body.children.length > 50) body.removeChild(body.lastChild);   // 仅保留最近 50 行

    // 顶部体征卡片：只更新已存在的数值节点，找不到就跳过（不新增 DOM 节点）
    var batteryNode = liveContainer.querySelector('[data-hero-battery]');
    if (batteryNode && data.battery !== null && data.battery !== undefined && data.battery !== '') {
      batteryNode.textContent = data.battery + '%';
    }
    var reportNode = liveContainer.querySelector('[data-hero-report]');
    if (reportNode) reportNode.textContent = U.relTime(ts);
  }

  /** 真实链路彻底不可用：回退改造前的 5 秒本地模拟 */
  function handleUnavailable(token) {
    if (token !== undefined && token !== liveToken) return;
    if (logTimer || !liveContainer || !liveDevice) return;
    startLogTimer(liveContainer, liveDevice);
  }

  /** 供 app.js 在 /devices/:id 路由下转交实时帧 */
  function onLiveVitals(data) {
    handleVitals(data, liveToken);
  }

  function onLiveUnavailable() {
    handleUnavailable(liveToken);
  }

  /** 注销本页实时回调：清空页面引用并推进序号，旧回调随即失效
      （共享链路不断开，告警浮窗等全局能力仍依赖该链路） */
  function detachLive() {
    liveToken++;
    liveContainer = null;
    liveDevice = null;
    liveDeviceId = '';
    liveLocation = '';
    lastFrameKey = '';
  }

  function destroy() {
    detachLive();
    if (logTimer) clearInterval(logTimer);
    logTimer = null;
  }

  function render(container, route) {
    if (route.params.id) renderDetail(container, route);
    else renderList(container);
  }

  YL.pages = YL.pages || {};
  YL.pages.devices = {
    render: render,
    destroy: destroy,
    onLiveVitals: onLiveVitals,
    onLiveUnavailable: onLiveUnavailable
  };
})(window);