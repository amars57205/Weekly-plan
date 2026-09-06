/**
 * ============================================================================
 *  الخادم الخلفي (Google Apps Script) - منصة الخطة الأسبوعية
 * ============================================================================
 *  يعمل هذا الكود كـ Web App يربط صفحة index.html بجدولين داخل نفس ملف
 *  Google Sheets:
 *
 *   1) "جدول صاحب الصلاحية"  : بيانات المدرسة + الرقم السري لصاحب الصلاحية
 *                              + قوائم الإضافة السريعة (أسابيع/صفوف/فصول/مواد)
 *                              + جدول تسجيل المعلمين (اسم + رقم سري).
 *
 *   2) "لوحة المعلمين"       : الخطط الأسبوعية والواجبات التي يدخلها المعلمون
 *                              (سطر واحد لكل: معلم + أسبوع + صف + فصل + مادة).
 *
 *  ---------------------------------------------------------------------------
 *  خطوات التركيب:
 *  1. أنشئ ملف Google Sheets جديد، وأضف فيه ورقتين بالاسمين بالضبط:
 *        "جدول صاحب الصلاحية"   و   "لوحة المعلمين"
 *     (يمكنك ترك محتوى الملفين اللذين أرسلتهما أو حذف محتواهما، فالكود
 *      سينشئ رؤوس الأعمدة تلقائياً في أول تشغيل).
 *  2. من القائمة: الإضافات (Extensions) > Apps Script، والصق هذا الكود بالكامل.
 *  3. غيّر قيمة API_SECRET بالأسفل إلى نص عشوائي طويل وسري خاص بك.
 *  4. Deploy > New deployment > اختر نوع "Web app":
 *        - Execute as: Me
 *        - Who has access: Anyone
 *     ثم انسخ رابط الـ Web App الناتج.
 *  5. الصق نفس الرابط في متغير API_URL، ونفس السر في API_SECRET داخل index.html
 * ============================================================================
 */

/* ============================ الإعدادات العامة ============================ */

const SHEET_ADMIN            = 'جدول صاحب الصلاحية';
const SHEET_TEACHERS_PLANS   = 'لوحة المعلمين';

// !! غيّر هذا المفتاح إلى نص عشوائي طويل وسرّي خاص بك قبل النشر !!
// (يمكنك توليد نص عشوائي من أي موقع "Random string generator")
const API_SECRET = 'REPLACE_WITH_YOUR_OWN_LONG_RANDOM_SECRET_2026';

// رؤوس أعمدة صف "إعدادات المدرسة" في ورقة صاحب الصلاحية (الصف 1 = عناوين، الصف 2 = القيم)
const ADMIN_SETTINGS_HEADERS = [
  'اسم المدرسة', 'الرقم الوزاري', 'الرقم السري لصاحب الصلاحية', 'عدد الزيارات',
  'الأسابيع (JSON)', 'الصفوف (JSON)', 'الفصول (JSON)', 'المواد (JSON)'
];
const ADMIN_SETTINGS_ROW = 2;

// جدول تسجيل المعلمين يبدأ من الصف 4 (رأس) والصف 5 (بيانات) داخل نفس ورقة صاحب الصلاحية
const TEACHERS_TABLE_HEADER_ROW = 4;
const TEACHERS_TABLE_START_ROW  = 5;
const TEACHERS_HEADERS = ['معرف المعلم', 'اسم المعلم', 'الرقم السري', 'تاريخ التسجيل'];

// رؤوس ورقة الخطط الأسبوعية للمعلمين
const PLANS_HEADERS = [
  'معرف المعلم', 'اسم المعلم', 'الأسبوع', 'الصف', 'الفصل', 'المادة',
  'الخطة والواجب', 'آخر تحديث'
];

/* ============================ نقاط الدخول ============================ */

function doGet(e) {
  return handleRequest(e, 'GET');
}

function doPost(e) {
  return handleRequest(e, 'POST');
}

function handleRequest(e, method) {
  // قفل لمنع تعارض الكتابة عند دخول أكثر من مستخدم بنفس اللحظة
  var lock = LockService.getScriptLock();
  var acquired = lock.tryLock(15000);
  if (!acquired) {
    return jsonOut({ result: 'error', message: 'الخادم مشغول حالياً، يرجى المحاولة مرة أخرى.' });
  }

  try {
    var params = {};
    if (method === 'GET') {
      params = (e && e.parameter) ? e.parameter : {};
    } else {
      var raw = (e && e.postData) ? e.postData.contents : '{}';
      params = JSON.parse(raw || '{}');
    }

    // تحقق أساسي من المفتاح السري (حماية أولى تمنع الطلبات العشوائية)
    if (params.secret !== API_SECRET) {
      return jsonOut({ result: 'error', message: 'وصول غير مصرح به.' });
    }

    var action = params.action;
    switch (action) {
      case 'getData':              return jsonOut(getAllData());
      case 'saveSchoolInfo':       return jsonOut(saveSchoolInfo(params));
      case 'changeAdminPassword':  return jsonOut(changeAdminPassword(params));
      case 'addQuickItem':         return jsonOut(addQuickItem(params));
      case 'registerTeacher':      return jsonOut(registerTeacher(params));
      case 'updateTeacher':        return jsonOut(updateTeacher(params));
      case 'deleteTeacher':        return jsonOut(deleteTeacher(params));
      case 'saveWeeklyPlan':       return jsonOut(saveWeeklyPlan(params));
      case 'incrementVisits':      return jsonOut(incrementVisits());
      default:
        return jsonOut({ result: 'error', message: 'إجراء غير معروف: ' + action });
    }
  } catch (err) {
    return jsonOut({ result: 'error', message: 'خطأ في الخادم: ' + err.toString() });
  } finally {
    lock.releaseLock();
  }
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================ تعقيم المدخلات ============================
   يمنع Formula Injection (=... أو +... أو -... أو @...) و يحدد طول النص
   ويحوّل أي قيمة غير نصية إلى نص آمن بشكل افتراضي.
=========================================================================== */
function sanitize(input, maxLen) {
  if (input === undefined || input === null) return '';
  var value = String(input).trim();
  if (maxLen) value = value.substring(0, maxLen);
  if (/^[=+\-@]/.test(value)) value = "'" + value;
  return value;
}

/* ============================ أدوات الوصول للأوراق ============================ */

function getAdminSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_ADMIN);
  if (!sh) throw new Error('لم يتم العثور على ورقة باسم: ' + SHEET_ADMIN);
  ensureAdminSheetStructure(sh);
  return sh;
}

function getPlansSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_TEACHERS_PLANS);
  if (!sh) throw new Error('لم يتم العثور على ورقة باسم: ' + SHEET_TEACHERS_PLANS);
  ensurePlansSheetStructure(sh);
  return sh;
}

function ensureAdminSheetStructure(sh) {
  var headerRow = sh.getRange(1, 1, 1, ADMIN_SETTINGS_HEADERS.length).getValues()[0];
  if (headerRow.join('') === '') {
    sh.getRange(1, 1, 1, ADMIN_SETTINGS_HEADERS.length).setValues([ADMIN_SETTINGS_HEADERS]);
  }
  var settingsRow = sh.getRange(ADMIN_SETTINGS_ROW, 1, 1, ADMIN_SETTINGS_HEADERS.length).getValues()[0];
  if (!settingsRow[2]) { // لا يوجد رقم سري لصاحب الصلاحية بعد => تهيئة أولية
    sh.getRange(ADMIN_SETTINGS_ROW, 1, 1, ADMIN_SETTINGS_HEADERS.length).setValues([[
      '', '', '1234', 0, '[]', '[]', '[]',
      JSON.stringify(['الرياضيات', 'العلوم', 'اللغة العربية', 'الإنجليزي'])
    ]]);
  }
  var teacherHeaderRow = sh.getRange(TEACHERS_TABLE_HEADER_ROW, 1, 1, TEACHERS_HEADERS.length).getValues()[0];
  if (teacherHeaderRow.join('') === '') {
    sh.getRange(TEACHERS_TABLE_HEADER_ROW, 1, 1, TEACHERS_HEADERS.length).setValues([TEACHERS_HEADERS]);
  }
}

function ensurePlansSheetStructure(sh) {
  var headerRow = sh.getRange(1, 1, 1, PLANS_HEADERS.length).getValues()[0];
  if (headerRow.join('') === '') {
    sh.getRange(1, 1, 1, PLANS_HEADERS.length).setValues([PLANS_HEADERS]);
  }
}

function safeParseArray(str) {
  try {
    var arr = JSON.parse(str);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

/* ============================ قراءة كل البيانات ============================ */

function getAllData() {
  var adminSh = getAdminSheet();
  var settings = adminSh.getRange(ADMIN_SETTINGS_ROW, 1, 1, ADMIN_SETTINGS_HEADERS.length).getValues()[0];

  var teachers = [];
  var lastRow = adminSh.getLastRow();
  if (lastRow >= TEACHERS_TABLE_START_ROW) {
    var tData = adminSh.getRange(
      TEACHERS_TABLE_START_ROW, 1,
      lastRow - TEACHERS_TABLE_START_ROW + 1, TEACHERS_HEADERS.length
    ).getValues();
    tData.forEach(function (row) {
      if (row[0]) teachers.push({ id: String(row[0]), name: row[1], password: row[2] });
    });
  }

  var plansSh = getPlansSheet();
  var plans = [];
  var lastPlanRow = plansSh.getLastRow();
  if (lastPlanRow >= 2) {
    var pData = plansSh.getRange(2, 1, lastPlanRow - 1, PLANS_HEADERS.length).getValues();
    pData.forEach(function (row) {
      if (row[0]) {
        plans.push({
          teacherId: String(row[0]), teacherName: row[1], week: row[2],
          grade: row[3], classroom: row[4], subject: row[5], content: row[6]
        });
      }
    });
  }

  return {
    result: 'success',
    schoolInfo: { name: settings[0] || '', code: settings[1] || '' },
    adminPass: settings[2] || '1234',
    visitsCount: settings[3] || 0,
    weeks: safeParseArray(settings[4]),
    grades: safeParseArray(settings[5]),
    classrooms: safeParseArray(settings[6]),
    subjects: safeParseArray(settings[7]),
    teachers: teachers,
    plans: plans
  };
}

/* ============================ إعدادات المدرسة ============================ */

function saveSchoolInfo(p) {
  var sh = getAdminSheet();
  sh.getRange(ADMIN_SETTINGS_ROW, 1).setValue(sanitize(p.schoolName, 100));
  sh.getRange(ADMIN_SETTINGS_ROW, 2).setValue(sanitize(p.schoolCode, 30));
  return { result: 'success', message: 'تم حفظ بيانات المدرسة' };
}

function changeAdminPassword(p) {
  var sh = getAdminSheet();
  var newPass = sanitize(p.newPass, 50);
  if (!newPass) return { result: 'error', message: 'الرقم السري فارغ' };
  sh.getRange(ADMIN_SETTINGS_ROW, 3).setValue(newPass);
  return { result: 'success', message: 'تم تحديث الرقم السري' };
}

function addQuickItem(p) {
  var sh = getAdminSheet();
  var colMap = { weeks: 5, grades: 6, classrooms: 7, subjects: 8 };
  var col = colMap[p.type];
  if (!col) return { result: 'error', message: 'نوع عنصر غير صحيح' };

  var value = sanitize(p.value, 50);
  if (!value) return { result: 'error', message: 'قيمة فارغة' };

  var cell = sh.getRange(ADMIN_SETTINGS_ROW, col);
  var arr = safeParseArray(cell.getValue());
  if (arr.indexOf(value) === -1) {
    arr.push(value);
    cell.setValue(JSON.stringify(arr));
  }
  return { result: 'success', message: 'تمت الإضافة بنجاح', list: arr };
}

/* ============================ إدارة المعلمين ============================ */

function registerTeacher(p) {
  var sh = getAdminSheet();
  var name = sanitize(p.name, 100);
  var password = sanitize(p.password, 50);
  if (!name || !password) return { result: 'error', message: 'الاسم أو الرقم السري فارغ' };

  var id = 't_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  var row = Math.max(sh.getLastRow() + 1, TEACHERS_TABLE_START_ROW);
  sh.getRange(row, 1, 1, 4).setValues([[id, name, password, new Date()]]);

  return { result: 'success', message: 'تم تسجيل المعلم', id: id };
}

function findTeacherRow(sh, id) {
  var lastRow = sh.getLastRow();
  if (lastRow < TEACHERS_TABLE_START_ROW) return -1;
  var ids = sh.getRange(TEACHERS_TABLE_START_ROW, 1, lastRow - TEACHERS_TABLE_START_ROW + 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return TEACHERS_TABLE_START_ROW + i;
  }
  return -1;
}

function updateTeacher(p) {
  var sh = getAdminSheet();
  var row = findTeacherRow(sh, p.id);
  if (row === -1) return { result: 'error', message: 'المعلم غير موجود' };
  sh.getRange(row, 2).setValue(sanitize(p.name, 100));
  sh.getRange(row, 3).setValue(sanitize(p.password, 50));
  return { result: 'success', message: 'تم تحديث بيانات المعلم' };
}

function deleteTeacher(p) {
  var sh = getAdminSheet();
  var row = findTeacherRow(sh, p.id);
  if (row === -1) return { result: 'error', message: 'المعلم غير موجود' };
  sh.deleteRow(row);
  return { result: 'success', message: 'تم حذف المعلم' };
}

/* ============================ الخطط الأسبوعية ============================ */

function saveWeeklyPlan(p) {
  var sh = getPlansSheet();

  var teacherId   = sanitize(p.teacherId, 100);
  var teacherName = sanitize(p.teacherName, 100);
  var week        = sanitize(p.week, 50);
  var grade       = sanitize(p.grade, 50);
  var classroom   = sanitize(p.classroom, 30);
  var subject     = sanitize(p.subject, 50);
  var content     = sanitize(p.content, 2000);

  if (!teacherId || !week || !grade || !classroom || !subject) {
    return { result: 'error', message: 'بيانات الخطة غير مكتملة' };
  }

  var lastRow = sh.getLastRow();
  var foundRow = -1;
  if (lastRow >= 2) {
    var data = sh.getRange(2, 1, lastRow - 1, 6).getValues();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]) === teacherId && data[i][2] === week &&
          data[i][3] === grade && data[i][4] === classroom && data[i][5] === subject) {
        foundRow = 2 + i;
        break;
      }
    }
  }

  var now = new Date();
  if (foundRow > -1) {
    sh.getRange(foundRow, 7).setValue(content);
    sh.getRange(foundRow, 8).setValue(now);
  } else {
    sh.appendRow([teacherId, teacherName, week, grade, classroom, subject, content, now]);
  }

  return { result: 'success', message: 'تم حفظ الخطة الأسبوعية' };
}

/* ============================ عداد الزيارات ============================ */

function incrementVisits() {
  var sh = getAdminSheet();
  var cell = sh.getRange(ADMIN_SETTINGS_ROW, 4);
  var current = parseInt(cell.getValue(), 10) || 0;
  var updated = current + 1;
  cell.setValue(updated);
  return { result: 'success', visitsCount: updated };
}
