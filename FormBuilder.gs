/**
 * ============================================================================
 *  FormBuilder.gs — Mengubah daftar soal (hasil AI / hasil edit) jadi
 *                   Google Form + Spreadsheet Kunci Jawaban
 * ============================================================================
 *  Tipe soal yang didukung:
 *    pg            → MultipleChoiceItem  (satu jawaban, auto-acak posisi benar)
 *    pg_kompleks   → CheckboxItem        (banyak jawaban benar)
 *    dropdown      → ListItem
 *    isian         → TextItem + validasi teks (kunci = teks persis)
 *    essay         → ParagraphTextItem   (tanpa nilai otomatis)
 *
 *  Ekstra: mode Kuis (poin + umpan balik), section header, acak urutan soal,
 *  wajib login, batasi 1 respons, folder Drive khusus, spreadsheet kunci.
 * ============================================================================
 */

var FormBuilder = (function () {

  var LABEL_TIPE = {
    pg: 'Pilihan Ganda',
    pg_kompleks: 'PG Kompleks (Jawaban Ganda)',
    dropdown: 'Dropdown',
    isian: 'Isian Singkat',
    essay: 'Essay / Uraian'
  };

  /* ====================== FOLDER DRIVE ================================== */

  /**
   * Menentukan folder tujuan. Terima ID folder, URL folder, atau kosong
   * (⇒ pakai/buat folder "Soal AI" di root Drive).
   */
  function resolveFolder_(folderRef) {
    var ref = String(folderRef || '').trim();
    if (ref) {
      var id = ref.indexOf('/') >= 0 ? extractId_(ref) : ref;
      try {
        return DriveApp.getFolderById(id);
      } catch (err) {
        throw new Error('Folder Drive tidak ditemukan: ' + ref + '. ' + err.message);
      }
    }
    var name = 'Soal AI';
    var it = DriveApp.getFoldersByName(name);
    if (it.hasNext()) return it.next();
    return DriveApp.createFolder(name);
  }

  /** Mengambil ID dari URL Drive (form/folder/spreadsheet). */
  function extractId_(url) {
    var m = String(url).match(/[-\w]{25,}/);
    return m ? m[0] : String(url);
  }

  /* ====================== UTIL SOAL ===================================== */

  function shuffle_(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function huruf_(i) { return String.fromCharCode(65 + i); }

  /**
   * Menormalkan satu soal dari payload client supaya tahan terhadap
   * perubahan bentuk data dari UI.
   */
  function normQuestion_(q, i) {
    q = q || {};
    var type = String(q.type || q.tipe || 'pg').toLowerCase();
    if (!LABEL_TIPE[type]) type = 'pg';

    var options = (q.options || q.opsi || []).map(function (o) {
      return String(o == null ? '' : o).trim();
    }).filter(function (o) { return o.length; });

    var correct = (q.correctIdx || q.benar || q.correct || []).map(function (c) {
      return typeof c === 'number' ? Math.round(c) : parseInt(String(c).trim(), 10);
    }).filter(function (c) { return !isNaN(c) && c >= 0 && c < options.length; });

    if (!correct.length && options.length) correct = [0];

    var points = Number(q.points || q.poin || 1);
    if (!isFinite(points) || points < 0) points = 1;

    var rawBenar = q.correctIdx || q.benar || q.correct || q.answerText || [];
    if (!Array.isArray(rawBenar)) rawBenar = [rawBenar];
    var answerText = (type === 'isian' || type === 'essay')
      ? String(rawBenar[0] == null ? '' : rawBenar[0]).trim()
      : '';

    return {
      n: i + 1,
      type: type,
      text: String(q.text || q.pertanyaan || q.question || ('Soal ' + (i + 1))).trim(),
      options: options,
      correct: correct,
      answerText: answerText,
      points: Math.round(points * 100) / 100,
      level: String(q.level || '').trim(),
      explanation: String(q.explanation || q.pembahasan || '').trim(),
      helpText: String(q.helpText || '').trim()
    };
  }

  /* ====================== PENAMBAHAN ITEM KE FORM ====================== */

  function addItems_(form, questions, opts) {
    var meta = [];
    questions.forEach(function (q) {
      var item = null, jawabanBenar = '';

      if (q.type === 'pg' || q.type === 'pg_kompleks' || q.type === 'dropdown') {
        var pairs = q.options.map(function (text, i) {
          return { text: text, correct: q.correct.indexOf(i) !== -1 };
        });
        if (opts.acakOpsi) pairs = shuffle_(pairs);

        var values = pairs.map(function (p) { return p.text; });
        var correctTexts = pairs.filter(function (p) { return p.correct; }).map(function (p) { return p.text; });
        jawabanBenar = correctTexts.join(' | ');

        if (q.type === 'pg') {
          item = form.addMultipleChoiceItem();
          item.setChoiceValues(values);
          item.setFeedbackForCorrect(
            FormApp.createFeedback().setText(feedbackText_(q, correctTexts[0] || '')).build());
          item.setFeedbackForIncorrect(
            FormApp.createFeedback().setText(feedbackWrongText_(q, correctTexts[0] || '')).build());
        } else if (q.type === 'pg_kompleks') {
          item = form.addCheckboxItem();
          item.setChoiceValues(values);
          item.setHelpText('Pilih ' + correctTexts.length + ' jawaban yang benar.');
          item.setFeedbackForCorrect(
            FormApp.createFeedback().setText(feedbackText_(q, correctTexts.join(', '))).build());
          item.setFeedbackForIncorrect(
            FormApp.createFeedback().setText(feedbackWrongText_(q, correctTexts.join(', '))).build());
        } else {
          item = form.addListItem();
          item.setChoiceValues(values);
          item.setFeedbackForCorrect(
            FormApp.createFeedback().setText(feedbackText_(q, correctTexts[0] || '')).build());
          item.setFeedbackForIncorrect(
            FormApp.createFeedback().setText(feedbackWrongText_(q, correctTexts[0] || '')).build());
        }
      } else if (q.type === 'isian') {
        item = form.addTextItem();
        var kunci = String(q.answerText || (q.options[q.correct[0]] || q.options[0] || '') || '').trim();
        jawabanBenar = kunci;
        if (kunci && opts.pakaiValidasiIsian !== false) {
          // Catatan: validasi Google Forms bersifat case-sensitive.
          var v = FormApp.createTextValidation().requireTextEqualTo(kunci);
          item.setValidation(v.setHelpText('Jawaban harus tepat: ' + kunci).build());
        }
        item.setFeedbackForCorrect(
          FormApp.createFeedback().setText(feedbackText_(q, kunci)).build());
      } else { // essay
        item = form.addParagraphTextItem();
        item.setRows(5);
        jawabanBenar = q.explanation || q.options.join(' ') || '(dinilai manual)';
        item.setGeneralFeedback(
          FormApp.createFeedback().setText(
            'Soal uraian dinilai manual oleh guru.' +
            (q.explanation ? '\n\nPoin kunci jawaban:\n' + q.explanation : '')
          ).build());
      }

      if (!item) return;

      var title = opts.nomorOtomatis ? (q.n + '. ' + q.text) : q.text;
      if (opts.tampilkanLevel && q.level) title += '  [' + q.level + ']';
      item.setTitle(title);
      if (q.helpText && item.setHelpText) item.setHelpText(q.helpText);
      if (opts.wajibSemua && item.setRequired) item.setRequired(true);

      if (opts.isQuiz && item.setPoints) {
        try { item.setPoints(q.points); } catch (e) { /* item tanpa nilai (essay) */ }
      }

      meta.push({ type: q.type, item: item, jawaban: jawabanBenar, q: q });
    });
    return meta;
  }

  function feedbackText_(q, kunci) {
    var t = '✅ Jawaban benar: ' + (kunci || '-');
    if (q.explanation) t += '\n\n' + q.explanation;
    if (q.level) t += '\n\n(Level: ' + q.level + ' · Poin: ' + q.points + ')';
    return t;
  }

  function feedbackWrongText_(q, kunci) {
    var t = '❌ Jawaban benar: ' + (kunci || '-');
    if (q.explanation) t += '\n\n' + q.explanation;
    return t;
  }

  /* ====================== KUNCI JAWABAN (SPREADSHEET) =================== */

  function createKeySpreadsheet_(folder, title, questions, opts) {
    var ss = SpreadsheetApp.create('KUNCI - ' + title);
    var sh = ss.getSheets()[0];
    sh.setName('Kunci Jawaban');

    var header = ['No', 'Tipe', 'Soal', 'Opsi Jawaban', 'Kunci', 'Poin', 'Level', 'Pembahasan'];
    sh.getRange(1, 1, 1, header.length).setValues([header])
      .setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');

    var rows = questions.map(function (q) {
      var opsi = q.options.map(function (o, i) { return huruf_(i) + '. ' + o; }).join('\n');
      var kunci = q.correct.map(function (i) { return huruf_(i); }).join(', ');
      if (q.type === 'isian') kunci = q.answerText || q.options[0] || '-';
      if (q.type === 'essay') kunci = (q.answerText ? q.answerText + '\n\n' : '') + '(dinilai manual)';
      return [q.n, LABEL_TIPE[q.type] || q.type, q.text, opsi, kunci, q.points, q.level, q.explanation];
    });
    if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);

    var totalPoin = questions.reduce(function (a, q) { return a + q.points; }, 0);
    var last = rows.length + 3;
    sh.getRange(last, 1).setValue('Total').setFontWeight('bold');
    sh.getRange(last, 6).setValue(totalPoin).setFontWeight('bold');
    sh.getRange(last + 1, 1).setValue('Jumlah soal').setFontWeight('bold');
    sh.getRange(last + 1, 6).setValue(questions.length);
    sh.getRange(last + 2, 1).setValue('Dibuat oleh');
    sh.getRange(last + 2, 6).setValue('Soal AI ➜ Google Form · ' + new Date());

    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 45);
    sh.setColumnWidth(2, 150);
    sh.setColumnWidth(3, 420);
    sh.setColumnWidth(4, 320);
    sh.setColumnWidth(5, 90);
    sh.setColumnWidth(6, 60);
    sh.setColumnWidth(7, 70);
    sh.setColumnWidth(8, 420);
    sh.getRange(2, 1, Math.max(rows.length, 1), header.length).setWrap(true).setVerticalAlignment('top');

    // Sheet info
    var info = ss.insertSheet('Info Latihan', 1);
    var infoRows = [
      ['Judul', title],
      ['Mata pelajaran', opts.spec.mapel || '-'],
      ['Kelas', opts.spec.kelas || '-'],
      ['Topik / Materi', opts.spec.topik || '-'],
      ['Kurikulum', opts.spec.kurikulum || '-'],
      ['Level kognitif', (opts.spec.level || []).join(', ')],
      ['Tingkat kesulitan', opts.spec.kesulitan || '-'],
      ['Jumlah soal', questions.length],
      ['Total poin', totalPoin],
      ['Model AI', opts.meta.model || '-'],
      ['Dibuat', Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Jakarta', 'dd MMM yyyy HH:mm')],
      ['Link Form (edit)', opts.formEditUrl || '-'],
      ['Link Form (isi)', opts.formPublishUrl || '-']
    ];
    info.getRange(1, 1, infoRows.length, 2).setValues(infoRows);
    info.getRange(1, 1, infoRows.length, 1).setFontWeight('bold').setBackground('#e8f0fe');
    info.setColumnWidth(1, 180);
    info.setColumnWidth(2, 520);

    try {
      var file = DriveApp.getFileById(ss.getId());
      var dest = folder;
      file.moveTo(dest);
    } catch (e) { /* biarkan di root bila gagal */ }

    return { id: ss.getId(), url: ss.getUrl() };
  }

  /* ====================== API UTAMA ===================================== */

  /**
   * payload = {
   *   spec: {...konfigurasi soal...},
   *   questions: [ {type,text,options,correctIdx,points,level,explanation}, ... ],
   *   form: {
   *     title, description, folderId, targetFormId, isQuiz, acakSoal, acakOpsi,
   *     requireLogin, limitOne, collectEmail, showProgressBar, tampilkanLevel,
   *     nomorOtomatis, wajibSemua, buatKunci, meta{model}
   *   }
   * }
   */
  function build(payload) {
    var raw = payload.questions || [];
    var questions = raw.map(normQuestion_).filter(function (q) { return q.text; });
    if (!questions.length) throw new Error('Tidak ada soal valid untuk dibuat.');

    var spec = payload.spec || {};
    var o = payload.form || {};
    var opts = {
      isQuiz: o.isQuiz !== false,
      acakSoal: !!o.acakSoal,
      acakOpsi: !!o.acakOpsi,
      requireLogin: !!o.requireLogin,
      limitOne: !!o.limitOne,
      collectEmail: !!o.collectEmail,
      showProgressBar: o.showProgressBar !== false,
      tampilkanLevel: !!o.tampilkanLevel,
      nomorOtomatis: o.nomorOtomatis !== false,
      wajibSemua: o.wajibSemua !== false,
      isianCaseSensitive: !!o.isianCaseSensitive,
      buatKunci: o.buatKunci !== false,
      spec: spec,
      meta: o.meta || {}
    };

    var title = String(o.title || '').trim() ||
      ('Latihan ' + (spec.mapel || '') + (spec.kelas ? ' - Kelas ' + spec.kelas : '') + ': ' + (spec.topik || '')).replace(/ - $/, '').trim();

    // ---------- Form baru atau tempel ke form lama ----------
    var form, isNew = true, folder;
    if (o.targetFormId) {
      var tid = String(o.targetFormId).indexOf('http') === 0 ? extractId_(o.targetFormId) : String(o.targetFormId).trim();
      form = FormApp.openById(tid);
      isNew = false;
      var parents = DriveApp.getFileById(tid).getParents();
      folder = parents.hasNext() ? parents.next() : resolveFolder_('');
    } else {
      folder = resolveFolder_(o.folderId);
      form = FormApp.create(title);
      try { DriveApp.getFileById(form.getId()).moveTo(folder); } catch (e) {}
    }

    form.setTitle(title);
    var desc = String(o.description || spec.deskripsi || '').trim();
    if (!desc) {
      desc = [
        (spec.mapel ? 'Mata Pelajaran: ' + spec.mapel : ''),
        (spec.kelas ? 'Kelas: ' + spec.kelas : ''),
        (spec.topik ? 'Materi: ' + spec.topik : ''),
        'Jumlah soal: ' + questions.length + ' · Total poin: ' +
          questions.reduce(function (a, q) { return a + q.points; }, 0),
        '',
        'Petunjuk: kerjakan dengan teliti. Soal dibuat dengan bantuan AI — sudah ditinjau guru.',
        'Dibuat: ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Jakarta', 'dd MMM yyyy HH:mm')
      ].filter(Boolean).join('\n');
    }
    form.setDescription(desc);

    // ---------- Pengaturan dasar ----------
    if (opts.isQuiz) {
      form.setIsQuiz(true);
      try {
        form.setShowLinkToRespondAgain(false);
      } catch (e) {}
    }
    form.setShuffleQuestionOrder(opts.acakSoal);
    form.setRequireLogin(opts.requireLogin);
    form.setAllowResponseEdits(false);
    form.setShowProgressIndicator(opts.showProgressBar);
    try { form.setCollectEmail(opts.collectEmail); } catch (e) {}
    if (opts.limitOne) {
      try { form.setLimitOneResponsePerUser(true); } catch (e) {}
    }

    // ---------- Section header (opsional, biar rapi) ----------
    if (o.pakaiSection) {
      form.addPageBreakItem()
        .setTitle(title)
        .setHelpText(desc.substring(0, 300));
    }

    // ---------- Tambahkan soal ----------
    addItems_(form, questions, opts);

    form.saveAndClose();

    // ---------- Kunci jawaban ----------
    var key = null;
    if (opts.buatKunci) {
      key = createKeySpreadsheet_(folder, title, questions, {
        spec: spec,
        meta: opts.meta,
        formEditUrl: form.getEditUrl(),
        formPublishUrl: form.getPublishedUrl()
      });
    }

    var breakdown = {};
    questions.forEach(function (q) { breakdown[q.type] = (breakdown[q.type] || 0) + 1; });

    return {
      ok: true,
      isNew: isNew,
      formId: form.getId(),
      title: title,
      editUrl: form.getEditUrl(),
      publishUrl: form.getPublishedUrl(),
      shortUrl: (function () { try { return form.getPublishedUrl(); } catch (e) { return ''; } })(),
      folderName: folder.getName(),
      folderUrl: folder.getUrl(),
      jumlahSoal: questions.length,
      totalPoin: questions.reduce(function (a, q) { return a + q.points; }, 0),
      breakdown: breakdown,
      kunci: key
    };
  }

  return {
    build: build,
    resolveFolder_: resolveFolder_,
    extractId_: extractId_,
    normQuestion_: normQuestion_,
    LABEL_TIPE: LABEL_TIPE
  };
})();
