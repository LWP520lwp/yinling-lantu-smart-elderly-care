/* ==========================================================================
   模拟数据层：平潭综合实验区乡村养老业务数据
   - 固定随机种子，保证每次打开数据一致
   - 时间基于"今天"动态生成，任何日期演示都合理
   ========================================================================== */
(function (global) {
  'use strict';
  var YL = global.YL;
  var U = YL.utils;
  var R = U.rng(20261103);

  var NOW = Date.now();

  /* ------------------------------------------------------------------
     1. 行政区划与村居（42 个合作村居）
     ------------------------------------------------------------------ */
  var VILLAGE_RAW = [
    ['东门社区', '海坛街道', 66, 97.0], ['辕门社区', '海坛街道', 46, 95.2],
    ['红山社区', '海坛街道', 52, 96.4], ['城中村', '海坛街道', 38, 88.1],
    ['澳前村', '澳前镇', 44, 92.3], ['紫岚村', '澳前镇', 36, 86.7],
    ['龙山村', '澳前镇', 61, 90.5], ['松南村', '澳前镇', 29, 78.4],
    ['光裕村', '澳前镇', 33, 84.2], ['北厝村', '北厝镇', 55, 93.6],
    ['娘宫村', '北厝镇', 27, 76.9], ['跨海村', '北厝镇', 31, 81.5],
    ['龙北村', '北厝镇', 40, 89.7], ['钱便澳村', '北厝镇', 24, 72.3],
    ['流水村', '流水镇', 49, 94.8], ['北港村', '流水镇', 35, 96.1],
    ['山门村', '流水镇', 26, 82.6], ['西楼村', '流水镇', 42, 88.9],
    ['裕藩村', '流水镇', 30, 79.5], ['大澳村', '流水镇', 22, 68.2],
    ['平原村', '平原镇', 37, 90.1], ['上攀村', '平原镇', 28, 74.8],
    ['东崮村', '平原镇', 21, 66.7], ['马腿村', '平原镇', 18, 61.9],
    ['苏澳村', '苏澳镇', 34, 87.3], ['看澳村', '苏澳镇', 25, 71.4],
    ['玉堂村', '苏澳镇', 23, 69.6], ['寨顶村', '苏澳镇', 19, 58.8],
    ['敖东村', '敖东镇', 32, 85.6], ['美楼村', '敖东镇', 26, 73.1],
    ['山岐澳村', '敖东镇', 20, 64.5], ['吉钓村', '敖东镇', 17, 56.2],
    ['白青村', '白青乡', 29, 83.4], ['青峰村', '白青乡', 24, 70.7],
    ['国彩村', '白青乡', 22, 67.8], ['屿头村', '屿头乡', 21, 77.3],
    ['东金村', '屿头乡', 18, 59.4], ['大练村', '大练乡', 16, 74.2],
    ['月举村', '大练乡', 15, 53.8], ['南海村', '南海乡', 14, 68.9],
    ['草屿村', '南海乡', 12, 48.6], ['中楼村', '中楼乡', 11, 80.2]
  ];

  var VILLAGES = VILLAGE_RAW.map(function (row, i) {
    var total = row[2], rate = row[3];
    return {
      id: 'V' + U.pad2(i + 1),
      name: row[0],
      town: row[1],
      total: total,
      rate: rate,
      registered: Math.round(total / (rate / 100)),
      serviceCount: Math.round(total * 3.4),
      orgs: (i % 3) + 1
    };
  });

  var VILLAGE_MAP = {};
  VILLAGES.forEach(function (v) { VILLAGE_MAP[v.name] = v; });

  var TOWNS = ['海坛街道', '澳前镇', '北厝镇', '流水镇', '平原镇', '苏澳镇', '敖东镇', '白青乡', '屿头乡', '大练乡', '南海乡', '中楼乡'];

  /* ------------------------------------------------------------------
     2. 字典
     ------------------------------------------------------------------ */
  var DICT = {
    health: {
      healthy: { text: '健康', cls: 'tag-green' },
      semi: { text: '半自理', cls: 'tag-orange' },
      disabled: { text: '失能', cls: 'tag-red' }
    },
    member: {
      ankang: { text: '安康版', cls: 'tag-brand', price: 199 },
      kanghu: { text: '康护版', cls: 'tag-orange', price: 399 },
      zunxiang: { text: '尊享版', cls: 'tag-gold', price: 699 },
      free: { text: '兜底免费', cls: 'tag-gray', price: 0 }
    },
    alertType: {
      fall: { text: '跌倒告警', short: '跌倒', icon: 'alert' },
      hr: { text: '心率异常', short: '心率', icon: 'heart' },
      bp: { text: '血压异常', short: '血压', icon: 'activity' },
      spo2: { text: '血氧过低', short: '血氧', icon: 'droplet' },
      fence: { text: '电子围栏越界', short: '围栏', icon: 'map-pin' }
    },
    alertStatus: {
      pending: { text: '待处理', cls: 'tag-red' },
      doing: { text: '处理中', cls: 'tag-orange' },
      done: { text: '已处置', cls: 'tag-green' },
      false: { text: '误报', cls: 'tag-gray' }
    },
    alertLevel: {
      critical: { text: '紧急', cls: 'tag-red' },
      normal: { text: '一般', cls: 'tag-orange' }
    },
    orderType: {
      care: { text: '上门关怀', icon: 'home' },
      accompany: { text: '陪诊服务', icon: 'heart' },
      rehab: { text: '康复护理', icon: 'activity' },
      house: { text: '家政帮助', icon: 'home' }
    },
    orderStatus: {
      pending: { text: '待处理', cls: 'tag-orange' },
      doing: { text: '进行中', cls: 'tag-brand' },
      done: { text: '已完成', cls: 'tag-green' },
      canceled: { text: '已取消', cls: 'tag-gray' }
    },
    deviceStatus: {
      online: { text: '在线', cls: 'online' },
      offline: { text: '离线', cls: 'offline' },
      fault: { text: '故障', cls: 'fault' }
    }
  };

  /* ------------------------------------------------------------------
     3. 老人档案（48 条重点服务对象）
     ------------------------------------------------------------------ */
  var NAMES = [
    ['林水妹', '女', 84], ['陈木金', '男', 79], ['翁金宝', '男', 88], ['林吓俤', '男', 76],
    ['游美玉', '女', 82], ['高依泉', '男', 91], ['林珠英', '女', 74], ['魏金水', '男', 86],
    ['念梅花', '女', 78], ['施吓梅', '女', 81], ['游吓泉', '男', 83], ['周金莲', '女', 72],
    ['薛玉凤', '女', 89], ['吴阿嫩', '女', 85], ['郑桃金', '女', 77], ['蔡依妹', '女', 80],
    ['杨水莲', '女', 73], ['刘金菊', '女', 87], ['丁吓明', '男', 75], ['曾珠玉', '女', 82],
    ['黄茂林', '男', 90], ['许水仙', '女', 76], ['李吓珠', '女', 84], ['张金弟', '男', 71],
    ['王美英', '女', 88], ['何依香', '女', 79], ['徐吓英', '女', 83], ['卓金凤', '女', 74],
    ['洪秋菊', '女', 81], ['潘水莲', '女', 77], ['谢金宝', '男', 85], ['苏玉兰', '女', 70],
    ['卢吓英', '女', 86], ['蒋金珠', '女', 78], ['姚水妹', '女', 80], ['叶秀兰', '女', 73],
    ['程金妹', '女', 84], ['范吓顺', '男', 82], ['彭美英', '女', 75], ['汪金莲', '女', 87],
    ['罗水玉', '女', 79], ['钟金兰', '女', 72], ['谭吓妹', '女', 81], ['陆依珠', '女', 83],
    ['邓金水', '男', 88], ['冯玉梅', '女', 76], ['曹秀金', '女', 85], ['石水仙', '女', 74]
  ];

  var FAMILY_SURNAME = ['林', '陈', '翁', '游', '施', '念', '高', '魏', '薛', '吴', '郑', '蔡', '杨', '刘'];
  var FAMILY_RELATION = ['女儿', '儿子', '儿媳', '孙子', '侄女'];
  var CHRONIC_POOL = ['高血压', '2 型糖尿病', '冠心病', '脑卒中后遗症', '骨关节炎', '慢性阻塞性肺病', '白内障'];
  var PHONE_PREFIX = ['138', '139', '150', '151', '158', '159', '177', '180', '186', '189'];

  var FLOW_VILLAGES = ['流水村', '北港村', '山门村', '西楼村', '裕藩村', '大澳村'];

  function healthOf(age) {
    var r = R();
    if (age >= 86) return r < .42 ? 'disabled' : (r < .82 ? 'semi' : 'healthy');
    if (age >= 80) return r < .2 ? 'disabled' : (r < .62 ? 'semi' : 'healthy');
    if (age >= 75) return r < .1 ? 'disabled' : (r < .4 ? 'semi' : 'healthy');
    return r < .05 ? 'disabled' : (r < .24 ? 'semi' : 'healthy');
  }

  function memberOf(health, idx) {
    if (idx % 7 === 3) return 'free';
    if (health === 'disabled') return R() < .55 ? 'kanghu' : 'zunxiang';
    if (health === 'semi') return R() < .5 ? 'kanghu' : 'ankang';
    return R() < .78 ? 'ankang' : 'kanghu';
  }

  function makeIdCard(birthYear, month, day, seq) {
    return '350128' + birthYear + U.pad2(month) + U.pad2(day) + U.pad2(seq % 100) + (seq % 9 + 1) + (seq % 7 + 1);
  }

  function makePhone() {
    return PHONE_PREFIX[U.randInt(R, 0, PHONE_PREFIX.length - 1)] + String(U.randInt(R, 10000000, 99999999));
  }

  function vitals(level, health) {
    var base = health === 'disabled' ? 1 : health === 'semi' ? .7 : .3;
    var abnormal = level === 'high';
    return {
      hr: abnormal ? U.randInt(R, 96, 112) : U.randInt(R, 64, 86),
      spo2: abnormal ? U.randInt(R, 89, 93) : U.randInt(R, 95, 99),
      sbp: abnormal ? U.randInt(R, 148, 172) : U.randInt(R, 118, 138),
      dbp: abnormal ? U.randInt(R, 88, 102) : U.randInt(R, 68, 84),
      temp: U.round(36.2 + base * .55 + R() * .3, 1),
      at: NOW - U.randInt(R, 2, 42) * 60000
    };
  }

  var ELDERS = NAMES.map(function (row, i) {
    var name = row[0], gender = row[1], age = row[2];
    var villageName = i < 12 ? FLOW_VILLAGES[i % FLOW_VILLAGES.length] : VILLAGES[U.randInt(R, 0, VILLAGES.length - 1)].name;
    var village = VILLAGE_MAP[villageName];
    var health = healthOf(age);
    var member = memberOf(health, i);
    var birthYear = new Date().getFullYear() - age;
    var birthMonth = U.randInt(R, 1, 12);
    var birthDay = U.randInt(R, 1, 28);
    var risk = health === 'disabled' ? 'high' : (health === 'semi' ? (R() < .3 ? 'high' : 'mid') : (R() < .12 ? 'mid' : 'low'));
    var chronicCount = health === 'disabled' ? U.randInt(R, 2, 3) : (health === 'semi' ? U.randInt(R, 1, 2) : U.randInt(R, 0, 1));
    var chronic = U.pickMany(R, CHRONIC_POOL, chronicCount);
    var familySurname = FAMILY_SURNAME[U.randInt(R, 0, FAMILY_SURNAME.length - 1)];

    return {
      id: 'E' + U.pad2(i + 1),
      name: name,
      gender: gender,
      age: age,
      birth: birthYear + '-' + U.pad2(birthMonth) + '-' + U.pad2(birthDay),
      idCard: makeIdCard(birthYear, birthMonth, birthDay, i + 11),
      villageId: village.id,
      village: village.name,
      town: village.town,
      address: '平潭综合实验区' + village.town + village.name + U.randInt(R, 12, 168) + '号',
      health: health,
      member: member,
      risk: risk,
      chronic: chronic,
      deviceId: 'YL-PT-2024-' + U.pad2(1001 + i),
      deviceBound: i % 16 !== 13,
      phone: i === 0 ? '18651475147' : makePhone(),
      familyName: i === 0 ? '林小雅' : (familySurname + U.pick(R, ['小燕', '志强', '美玲', '建华', '文杰', '秀珍', '海东', '晓雯'])),
      relation: i === 0 ? '女儿' : U.pick(R, FAMILY_RELATION),
      lastVitals: vitals(risk, health),
      joinedAt: U.daysAgo(U.randInt(R, 60, 900)),
      volunteer: U.pick(R, ['蔡文静', '念晓东', '施小燕', '高建平', '魏丽云', '林美珍']),
      avatarClass: ['', 'x-warm', 'x-green', 'x-slate'][i % 4]
    };
  });

  var ELDER_MAP = {};
  ELDERS.forEach(function (e) { ELDER_MAP[e.id] = e; });

  /* ------------------------------------------------------------------
     4. 设备（与重点服务对象一一绑定）
     ------------------------------------------------------------------ */
  var FIRMWARE = ['HarmonyOS Wear 3.2.1', 'HarmonyOS Wear 3.2.1', 'HarmonyOS Wear 3.1.8', 'HarmonyOS Wear 2.9.4'];
  var DEVICES = ELDERS.map(function (e, i) {
    var status = 'online';
    if (i === 7 || i === 23 || i === 38) status = 'offline';
    if (i === 16) status = 'fault';
    var battery = status === 'fault' ? 0 : (status === 'offline' ? U.randInt(R, 6, 24) : U.randInt(R, 34, 98));
    return {
      id: e.deviceId,
      iotId: '6a3f9c2e1b7d4f8a9c' + U.pad2(i + 10) + 'd2',
      elderId: e.deviceBound ? e.id : null,
      elderName: e.deviceBound ? e.name : '未绑定',
      village: e.village,
      town: e.town,
      type: '银龄守护手环 P1',
      status: status,
      lastReport: status === 'offline' ? NOW - U.randInt(R, 4, 26) * 3600000 : NOW - U.randInt(R, 1, 9) * 60000,
      battery: battery,
      firmware: FIRMWARE[i % 4],
      activatedAt: U.daysAgo(U.randInt(R, 30, 600)),
      imei: '8691' + String(U.randInt(R, 10000000, 99999999)) + U.randInt(R, 10, 99),
      mac: 'A4:5E:60:' + U.pad2(U.randInt(R, 10, 99)) + ':' + U.pad2(U.randInt(R, 10, 99)) + ':' + U.pad2(U.randInt(R, 10, 99)),
      signal: status === 'offline' ? 0 : U.randInt(R, 2, 4)
    };
  });

  /* ------------------------------------------------------------------
     5. 告警（24 条，含今日与近 3 日）
     ------------------------------------------------------------------ */
  var ALERT_PLAN = [
    [0, 'fall', 'critical', 'pending', 4], [3, 'hr', 'critical', 'pending', 9],
    [6, 'spo2', 'critical', 'pending', 17], [9, 'bp', 'normal', 'pending', 28],
    [12, 'fence', 'normal', 'pending', 41], [15, 'hr', 'normal', 'pending', 66],
    [2, 'fall', 'critical', 'doing', 96], [18, 'spo2', 'critical', 'done', 140],
    [21, 'bp', 'normal', 'done', 210], [5, 'hr', 'normal', 'done', 320],
    [8, 'fence', 'normal', 'done', 470], [11, 'fall', 'critical', 'done', 620],
    [24, 'hr', 'critical', 'done', 900], [27, 'spo2', 'normal', 'false', 1100],
    [30, 'bp', 'normal', 'done', 1430], [33, 'fence', 'normal', 'done', 1610],
    [36, 'fall', 'critical', 'done', 1880], [39, 'hr', 'critical', 'done', 2150],
    [42, 'spo2', 'normal', 'false', 2400], [44, 'bp', 'normal', 'done', 2680],
    [46, 'fence', 'normal', 'done', 2960], [1, 'fall', 'critical', 'done', 3240],
    [4, 'hr', 'normal', 'done', 3520], [7, 'spo2', 'critical', 'done', 3800]
  ];

  var ALERT_HANDLE = ['联系家属并上门核实', '已派单就近社工，15 分钟内到达', '已拨打 120，救护车已到达', '远程确认老人安全，属误触', '村居网格员已上门查看'];
  var ALERT_RESULT = [
    '与家属视频确认，老人状态平稳，已叮嘱按时服药。',
    '社工上门测量血压 152/94，已协助服用降压药并登记随访。',
    '手环误判为跌倒，老人正在做家务，已关闭本次告警。',
    '老人外出走到村口，已由邻居陪同返回，同步调整电子围栏半径。',
    '血氧短时下降，休息后恢复至 96%，已纳入本周重点随访。'
  ];

  var ALERTS = ALERT_PLAN.map(function (plan, i) {
    var elder = ELDERS[plan[0] % ELDERS.length];
    var type = plan[1], level = plan[2], status = plan[3], ago = plan[4];
    var time = NOW - ago * 60000;
    return {
      id: 'AL' + U.fmtDate(time, 'YYYYMMDD') + U.pad2(i + 1),
      time: time,
      elderId: elder.id,
      elderName: elder.name,
      elderAge: elder.age,
      village: elder.village,
      town: elder.town,
      address: elder.address,
      phone: elder.phone,
      familyName: elder.familyName,
      relation: elder.relation,
      type: type,
      level: level,
      status: status,
      handler: status === 'pending' ? '' : (status === 'false' ? '蔡文静' : U.pick(R, ['蔡文静', '念晓东', '施小燕', '高建平'])),
      handleWay: status === 'pending' ? '' : U.pick(R, ['联系家属', '派单社工', '呼叫 120']),
      result: status === 'pending' ? '' : U.pick(R, ALERT_RESULT),
      metric: type === 'hr' ? (U.randInt(R, 104, 126) + ' bpm') :
        type === 'spo2' ? (U.randInt(R, 87, 92) + '%') :
          type === 'bp' ? (U.randInt(R, 156, 178) + '/' + U.randInt(R, 94, 106) + ' mmHg') :
            type === 'fall' ? '加速度突变 3.8g' : ('偏离围栏 ' + U.randInt(R, 180, 460) + 'm'),
      location: 'E 119.78' + U.randInt(R, 10, 99) + '° / N 25.50' + U.randInt(R, 10, 99) + '°',
      duration: U.randInt(R, 3, 26) + ' 分钟'
    };
  }).sort(function (a, b) { return b.time - a.time; });

  /* ------------------------------------------------------------------
     6. 服务工单（22 条）
     ------------------------------------------------------------------ */
  var ORDER_PLAN = [
    [1, 'care', 'pending', 3], [4, 'accompany', 'pending', 5], [7, 'rehab', 'doing', 8],
    [10, 'care', 'pending', 12], [13, 'house', 'doing', 15], [16, 'rehab', 'pending', 18],
    [19, 'care', 'doing', 22], [22, 'accompany', 'pending', 26], [25, 'rehab', 'doing', 30],
    [28, 'care', 'done', 34], [31, 'house', 'done', 40], [34, 'accompany', 'done', 46],
    [37, 'care', 'done', 52], [40, 'rehab', 'done', 58], [43, 'house', 'canceled', 64],
    [45, 'care', 'done', 72], [0, 'rehab', 'done', 80], [2, 'accompany', 'done', 88],
    [5, 'care', 'done', 96], [8, 'house', 'done', 104], [11, 'rehab', 'done', 112],
    [14, 'care', 'done', 120]
  ];

  var ORDER_SUMMARY = [
    '老人精神状态良好，血压偏高，已提醒按时服用降压药。',
    '陪同前往平潭协和医院复诊，取药并记录医嘱。',
    '完成关节康复训练 40 分钟，老人配合度较好。',
    '协助打扫房屋、清洗衣物，更换床上用品。',
    '代购生活物资并检查燃气、用电安全。'
  ];

  var ORDERS = ORDER_PLAN.map(function (plan, i) {
    var elder = ELDERS[plan[0] % ELDERS.length];
    var type = plan[1], status = plan[2], hoursAgo = plan[3];
    var created = NOW - (hoursAgo + 26) * 3600000;
    var appoint = NOW - hoursAgo * 3600000 + 2 * 3600000;
    return {
      id: 'WO' + U.fmtDate(created, 'YYYYMMDD') + U.pad2(i + 1),
      elderId: elder.id,
      elderName: elder.name,
      village: elder.village,
      town: elder.town,
      phone: elder.phone,
      type: type,
      status: status,
      owner: U.pick(R, ['蔡文静', '念晓东', '施小燕', '高建平', '魏丽云', '林美珍']),
      volunteer: U.pick(R, ['陈思远', '林小满', '翁雨晴', '念佳怡', '蔡子豪', '周晓彤', '游书航', '施安安']),
      appointAt: appoint,
      createdAt: created,
      remark: U.pick(R, ['老人独居，请提前电话联系。', '需携带血压计上门。', '家属希望服务后反馈照片。', '注意老人行动不便，需搀扶。']),
      summary: status === 'done' ? U.pick(R, ORDER_SUMMARY) : '',
      rating: status === 'done' ? U.randInt(R, 4, 5) : 0,
      duration: status === 'done' ? U.randInt(R, 40, 120) : 0,
      photos: status === 'done' ? 2 : 0
    };
  }).sort(function (a, b) { return b.createdAt - a.createdAt; });

  /* ------------------------------------------------------------------
     7. 志愿者 / 机构 / 账号
     ------------------------------------------------------------------ */
  var VOLUNTEERS = [
    { name: '陈思远', org: '平潭义工协会', hours: 286, services: 74, village: '北港村' },
    { name: '林小满', org: '福州工商学院', hours: 214, services: 61, village: '流水村' },
    { name: '翁雨晴', org: '平潭义工协会', hours: 198, services: 55, village: '山门村' },
    { name: '念佳怡', org: '银龄岚途志愿队', hours: 176, services: 49, village: '西楼村' },
    { name: '蔡子豪', org: '福州工商学院', hours: 162, services: 43, village: '裕藩村' },
    { name: '周晓彤', org: '银龄岚途志愿队', hours: 148, services: 38, village: '大澳村' },
    { name: '游书航', org: '平潭义工协会', hours: 132, services: 35, village: '北厝村' },
    { name: '施安安', org: '银龄岚途志愿队', hours: 118, services: 31, village: '澳前村' }
  ];

  var ORGS = [
    { name: '平潭综合实验区社会福利中心', type: '养老机构', village: '东门社区', beds: 220, contact: '0591-2431 8801' },
    { name: '岚城居家养老服务中心', type: '居家服务', village: '城中村', beds: 86, contact: '0591-2431 8825' },
    { name: '北港村幸福院', type: '农村幸福院', village: '北港村', beds: 42, contact: '0591-2432 1170' },
    { name: '流水镇敬老院', type: '养老机构', village: '流水村', beds: 120, contact: '0591-2432 1199' },
    { name: '澳前镇日间照料中心', type: '日间照料', village: '澳前村', beds: 38, contact: '0591-2433 2046' },
    { name: '苏澳镇幸福院', type: '农村幸福院', village: '苏澳村', beds: 36, contact: '0591-2434 3312' },
    { name: '平原镇敬老院', type: '养老机构', village: '平原村', beds: 78, contact: '0591-2435 6620' },
    { name: '敖东镇居家服务站', type: '居家服务', village: '敖东村', beds: 30, contact: '0591-2436 7781' },
    { name: '白青乡幸福院', type: '农村幸福院', village: '白青村', beds: 28, contact: '0591-2437 1129' },
    { name: '屿头乡敬老院', type: '养老机构', village: '屿头村', beds: 44, contact: '0591-2438 3350' },
    { name: '大练乡幸福院', type: '农村幸福院', village: '大练村', beds: 26, contact: '0591-2439 2204' },
    { name: '南海乡敬老院', type: '养老机构', village: '南海村', beds: 32, contact: '0591-2440 6678' }
  ];

  var ACCOUNTS = [
    { id: 'U001', name: '林晓岚', account: 'admin', role: 'admin', phone: '139****2186', village: '全域', status: 'active', lastLogin: NOW - 26 * 60000 },
    { id: 'U002', name: '蔡文静', account: 'shegong01', role: 'social', phone: '138****7302', village: '流水镇 · 北港村', status: 'active', lastLogin: NOW - 3 * 3600000 },
    { id: 'U003', name: '林小雅', account: 'family01', role: 'family', phone: '186****5147', village: '流水镇 · 流水村', status: 'active', lastLogin: NOW - 26 * 3600000 },
    { id: 'U004', name: '念晓东', account: 'shegong02', role: 'social', phone: '159****8821', village: '北厝镇 · 北厝村', status: 'active', lastLogin: NOW - 5 * 3600000 },
    { id: 'U005', name: '施小燕', account: 'shegong03', role: 'social', phone: '150****3390', village: '澳前镇 · 澳前村', status: 'active', lastLogin: NOW - 9 * 3600000 },
    { id: 'U006', name: '魏丽云', account: 'shegong04', role: 'social', phone: '177****6614', village: '苏澳镇 · 苏澳村', status: 'disabled', lastLogin: NOW - 21 * 24 * 3600000 }
  ];

  var LOGS = [
    { time: NOW - 4 * 60000, user: '蔡文静', action: '处置跌倒告警 AL' + U.fmtDate(NOW, 'YYYYMMDD') + '01', ip: '10.24.8.116', level: 'warn' },
    { time: NOW - 18 * 60000, user: '林晓岚', action: '导出养老服务覆盖率报表（月）', ip: '10.24.8.102', level: 'info' },
    { time: NOW - 42 * 60000, user: '林晓岚', action: '修改告警阈值：心率上限 100→105 bpm', ip: '10.24.8.102', level: 'warn' },
    { time: NOW - 66 * 60000, user: '念晓东', action: '新增老人档案：卢吓英（北厝村）', ip: '10.24.8.131', level: 'info' },
    { time: NOW - 3 * 3600000, user: '施小燕', action: '创建上门关怀工单 WO' + U.fmtDate(NOW, 'YYYYMMDD') + '04', ip: '10.24.8.124', level: 'info' },
    { time: NOW - 5 * 3600000, user: '系统', action: '华为云 IoT 设备批量同步：1,142 台在线', ip: 'iot-gateway', level: 'info' },
    { time: NOW - 7 * 3600000, user: '林晓岚', action: '停用账号 shegong04（魏丽云）', ip: '10.24.8.102', level: 'warn' },
    { time: NOW - 26 * 3600000, user: '林晓岚', action: '角色权限变更：社工角色增加工单创建权限', ip: '10.24.8.102', level: 'warn' }
  ];

  /* ------------------------------------------------------------------
     8. 汇总指标与图表数据
     ------------------------------------------------------------------ */
  var SUMMARY = {
    region: '平潭综合实验区',
    elderTotal: 1268,
    elderRegistered: 1504,
    guarantee: 118,
    villages: 42,
    orgs: 12,
    associations: 39,
    deviceTotal: 1245,
    deviceOnline: 1142,
    deviceOffline: 78,
    deviceFault: 25,
    deviceOnlineRate: 91.7,
    todayAlerts: 17,
    alertPending: 6,
    alertDone: 9,
    alertFalse: 2,
    todayOrders: 63,
    orderPending: 18,
    orderDoing: 12,
    orderDone: 33,
    volunteers: 486,
    volunteerHours: 18420,
    volunteerHoursMonth: 1846,
    responseAvg: 8.6,
    completionRate: 96.4,
    coverageRate: 84.3,
    health: { healthy: 742, semi: 386, disabled: 140 },
    members: { ankang: 512, kanghu: 386, zunxiang: 252, free: 118 },
    alertTypes: { fall: 4, hr: 5, bp: 3, spo2: 3, fence: 2 },
    orderTypes: { care: 186, accompany: 92, rehab: 74, house: 58 },
    chronic: [
      { name: '高血压', value: 46.2 },
      { name: '2 型糖尿病', value: 21.4 },
      { name: '冠心病', value: 12.8 },
      { name: '骨关节炎', value: 9.6 },
      { name: '慢阻肺', value: 5.4 },
      { name: '其他慢病', value: 4.6 }
    ]
  };

  /* 近 7 天体征趋势 */
  var TREND7 = {
    labels: ['10-28', '10-29', '10-30', '10-31', '11-01', '11-02', '11-03'],
    hr: [76, 78, 77, 79, 78, 80, 79],
    sbp: [133, 135, 134, 137, 136, 138, 136],
    dbp: [82, 83, 82, 85, 84, 86, 84],
    spo2: [96.2, 96.0, 95.8, 96.1, 95.6, 95.4, 95.9]
  };
  /* 标签随当前日期滚动 */
  (function () {
    var arr = [];
    for (var i = 6; i >= 0; i--) arr.push(U.fmtDate(U.daysAgo(i), 'MM-DD'));
    TREND7.labels = arr;
  })();

  /* 24 小时告警分布 */
  var ALERT_HOURS = [1, 0, 0, 0, 1, 2, 1, 3, 2, 1, 2, 1, 1, 2, 3, 2, 1, 2, 3, 4, 3, 2, 1, 1];

  /* 设备在线率近 7 天 */
  var DEVICE_RATE7 = {
    labels: TREND7.labels.slice(),
    values: [92.4, 92.1, 91.6, 90.8, 91.3, 91.9, 91.7]
  };

  /* 月度服务量 */
  var MONTH_SERVICE = {
    labels: ['6 月', '7 月', '8 月', '9 月', '10 月', '11 月'],
    care: [142, 158, 166, 174, 181, 186],
    accompany: [61, 68, 72, 79, 86, 92],
    rehab: [48, 53, 58, 63, 69, 74],
    house: [39, 44, 47, 51, 55, 58]
  };

  /* 服务效能：近 6 周 */
  var EFFICIENCY = {
    labels: ['W39', 'W40', 'W41', 'W42', 'W43', 'W44'],
    completion: [94.2, 94.8, 95.1, 95.9, 96.0, 96.4],
    response: [11.2, 10.6, 9.8, 9.4, 8.9, 8.6]
  };

  /* ------------------------------------------------------------------
     9. 派生数据方法
     ------------------------------------------------------------------ */
  var SERVICE_TYPES = ['上门关怀', '陪诊服务', '康复护理', '告警处置', '家政帮助'];

  /** 生成某位老人近 N 天的体征序列 */
  function vitalSeries(elder, days) {
    var r = U.rng(Number(String(elder.id).replace(/\D/g, '')) * 977 + days);
    var out = { labels: [], hr: [], sbp: [], dbp: [], spo2: [] };
    var hrBase = 68 + (elder.age - 70) * .35;
    var sbpBase = 122 + (elder.health === 'disabled' ? 16 : elder.health === 'semi' ? 9 : 2);
    var spo2Base = 97.4 - (elder.health === 'disabled' ? 2.4 : elder.health === 'semi' ? 1.1 : .2);
    for (var i = days - 1; i >= 0; i--) {
      var d = U.daysAgo(i);
      out.labels.push(U.fmtDate(d, 'MM-DD'));
      out.hr.push(Math.round(hrBase + (r() - .5) * 12 + (i < 3 ? 2 : 0)));
      out.sbp.push(Math.round(sbpBase + (r() - .5) * 16));
      out.dbp.push(Math.round(sbpBase * .62 + (r() - .5) * 8));
      out.spo2.push(U.round(spo2Base + (r() - .5) * 1.8, 1));
    }
    return out;
  }

  /** 生成某位老人的服务与处置记录 */
  function serviceRecords(elder) {
    var r = U.rng(Number(String(elder.id).replace(/\D/g, '')) * 31 + 7);
    var list = [];
    for (var i = 0; i < 6; i++) {
      var type = SERVICE_TYPES[Math.floor(r() * SERVICE_TYPES.length)];
      list.push({
        id: 'SR' + U.pad2(i + 1),
        type: type,
        time: U.daysAgo(i * 4 + Math.floor(r() * 3), 9 + Math.floor(r() * 8), Math.floor(r() * 59)),
        worker: U.pick(r, ['蔡文静', '念晓东', '施小燕', '高建平', '魏丽云']),
        note: U.pick(r, [
          '测量血压 138/84，老人精神状态良好。',
          '陪同前往镇卫生院复查，血糖 6.8 mmol/L。',
          '完成康复训练，指导家属日常按摩手法。',
          '协助整理居所，检查用电与燃气安全。',
          '跌倒告警回访，确认老人身体无外伤。'
        ])
      });
    }
    return list;
  }

  /** 生成设备上报日志 */
  function deviceLogs(device) {
    var r = U.rng(Number(String(device.id).replace(/\D/g, '')));
    var list = [];
    for (var i = 0; i < 10; i++) {
      var fall = i === 3;
      list.push({
        time: NOW - i * 7 * 60000 - 40000,
        hr: Math.round(70 + (r() - .5) * 14),
        spo2: Math.round(95 + r() * 3),
        step: Math.round(r() * 260),
        fall: fall,
        location: device.village + ' · 距村部 ' + Math.round(r() * 600) + ' 米'
      });
    }
    return list;
  }

  /** 角色可访问的老人集合 */
  function eldersByRole(role, scopeTown) {
    if (role === 'family') return ELDERS.filter(function (e) { return e.id === 'E01'; });
    if (role === 'social') {
      var list = ELDERS.filter(function (e) { return e.town === (scopeTown || '流水镇'); });
      return list.length ? list : ELDERS.slice(0, 12);
    }
    return ELDERS;
  }

  global.YL.data = {
    NOW: NOW,
    VILLAGES: VILLAGES,
    VILLAGE_MAP: VILLAGE_MAP,
    TOWNS: TOWNS,
    DICT: DICT,
    ELDERS: ELDERS,
    ELDER_MAP: ELDER_MAP,
    DEVICES: DEVICES,
    ALERTS: ALERTS,
    ORDERS: ORDERS,
    VOLUNTEERS: VOLUNTEERS,
    ORGS: ORGS,
    ACCOUNTS: ACCOUNTS,
    LOGS: LOGS,
    SUMMARY: SUMMARY,
    TREND7: TREND7,
    ALERT_HOURS: ALERT_HOURS,
    DEVICE_RATE7: DEVICE_RATE7,
    MONTH_SERVICE: MONTH_SERVICE,
    EFFICIENCY: EFFICIENCY,
    vitalSeries: vitalSeries,
    serviceRecords: serviceRecords,
    deviceLogs: deviceLogs,
    eldersByRole: eldersByRole
  };
})(window);