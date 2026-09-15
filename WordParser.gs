/**
 * ===========================================================================
 *  WordParser.gs — Unggah .docx / teks soal guru → daftar soal JSON
 * ===========================================================================
 *  Format yang dikenali (umum di naskah ujian Indonesia):
 *    1. Pertanyaan …
 *    a. opsi     A. opsi     *A. opsi (bintang / cetak tebal = kunci)
 *    b. opsi
 *    Jawaban: B
 *    Pembahasan: …
 *
 *    Wacana / Bacaan / Paparan
 *    …teks…
 *
 *    Kunci Jawaban
 *    1. A    2. B,C
 * ===========================================================================
 */
var WordParser = (function () {

  var MAX_B64_ = 8 * 1024 * 1024;

  function parse(payload) {
    payload = payload || {};
    var nama = String(payload.filename || payload.nama || 'soal.docx');
    var poin = Number(payload.poin || payload.points || 1);
    if (!isFinite(poin) || poin < 0) poin = 1;

    var teks = String(payload.text || payload.teks || '').trim();
    if (!teks) {
      var b64 = String(payload.base64 || payload.data || '');
      if (!b64) throw new Error('Tidak ada file atau teks yang diunggah.');
      if (b64.length > MAX_B64_) throw new Error('File terlalu besar (maks ±6 MB). Pecah naskah atau simpan sebagai .docx lebih ringkas.');
      var bytes = Utilities.base64Decode(b64);
      teks = bytesToText_(bytes, nama);
    }
    teks = String(teks || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!teks) throw new Error('File tidak berisi teks. Gambar/scan perlu diketik ulang atau OCR dulu.');

    var questions = parseTeks_(teks, poin);
    if (!questions.length) {
      throw new Error('Tidak menemukan soal bernomor. Pastikan format seperti:\n1. Pertanyaan\nA. opsi\nB. opsi');
    }
    return {
      ok: true,
      questions: questions,
      meta: {
        model: 'word',
        provider: 'upload',
        sumber: nama,
        jumlahSoal: questions.length,
        judul: judulDariNama_(nama)
      }
    };
  }

  function judulDariNama_(nama) {
    return String(nama || '')
      .replace(/\.(docx|doc|txt|rtf|md)$/i, '')
      .replace(/[_-]+/g, ' ')
      .trim() || 'Soal dari Word';
  }

  function bytesToText_(bytes, nama) {
    var lower = String(nama || '').toLowerCase();
    if (/\.docx$/.test(lower) || isZip_(bytes)) return docxToText_(bytes, nama);
    if (/\.doc$/.test(lower)) {
      throw new Error('File .doc (Word lama) tidak dibaca langsung. Di Word pilih File ▸ Simpan sebagai ▸ .docx, lalu unggah lagi.');
    }
    return Utilities.newBlob(bytes).getDataAsString('UTF-8');
  }

  function isZip_(bytes) {
    return bytes && bytes.length >= 4 && bytes[0] === 80 && bytes[1] === 75;
  }

  function docxToText_(bytes, nama) {
    var zipBlob = Utilities.newBlob(bytes, 'application/zip', 'soal.zip');
    var parts;
    try {
      parts = Utilities.unzip(zipBlob);
    } catch (e) {
      throw new Error('Gagal membuka .docx (' + (nama || '') + '). Simpan ulang dari Microsoft Word sebagai .docx.');
    }
    var xml = '';
    var i;
    for (i = 0; i < parts.length; i++) {
      var n = String(parts[i].getName() || '');
      if (n === 'word/document.xml' || /\/document\.xml$/i.test(n)) {
        xml = parts[i].getDataAsString('UTF-8');
        break;
      }
    }
    if (!xml) throw new Error('document.xml tidak ada di file Word.');
    return xmlToText_(xml);
  }

  function decodeXml_(s) {
    return String(s || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
        return String.fromCharCode(parseInt(h, 16));
      })
      .replace(/&#(\d+);/g, function (_, d) {
        return String.fromCharCode(parseInt(d, 10));
      });
  }

  function runBold_(run) {
    if (/<w:b\s+w:val="0"/.test(run) || /<w:bCs\s+w:val="0"/.test(run)) return false;
    return /<w:b\b/.test(run) || /<w:b\/>/.test(run);
  }

  function xmlToText_(xml) {
    xml = String(xml || '')
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n');
    var blocks = xml.split(/<\/w:p>/);
    var lines = [];
    var bi;
    for (bi = 0; bi < blocks.length; bi++) {
      var p = blocks[bi];
      var line = '';
      var runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
      var r;
      var ada = false;
      while ((r = runRe.exec(p))) {
        ada = true;
        var run = r[1];
        var t = '';
        var tre = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
        var tm;
        while ((tm = tre.exec(run))) t += tm[1];
        if (!t) continue;
        if (runBold_(run) && t.trim()) line += '[[' + t + ']]';
        else line += t;
      }
      if (!ada) {
        var tre2 = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
        var tm2;
        while ((tm2 = tre2.exec(p))) line += tm2[1];
      }
      line = decodeXml_(line).replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
      if (line) lines.push(line);
    }
    return lines.join('\n');
  }

  function hurufIdx_(ch) {
    var c = String(ch || '').toUpperCase();
    if (c >= 'A' && c <= 'E') return c.charCodeAt(0) - 65;
    return -1;
  }

  function stripTebal_(s) {
    var m = { text: String(s || ''), bold: false };
    if (/\[\[/.test(m.text)) m.bold = true;
    m.text = m.text.replace(/\[\[|\]\]/g, '').replace(/\s+/g, ' ').trim();
    return m;
  }

  function isKunciHeader_(line) {
    return /^\s*(kunci(\s+jawaban)?|daftar\s+kunci|answer\s*keys?)\s*[:.]?\s*$/i.test(line);
  }

  function isWacanaHeader_(line) {
    return /^\s*(wacana|bacaan|stimulus|paparan|teks(\s+berikut)?|cerita|passage|stimulus teks)\b/i.test(line) ||
      /^\s*bacalah\s+(teks|wacana|bacaan|kutipan)\b/i.test(line);
  }

  function isSkip_(line) {
    return /^\s*(nama|kelas|sekolah|mata\s*pelajaran|mapel|waktu|hari\/?tanggal|petunjuk(\s+pengerjaan)?|lembar\s+soal|ujia?n|penilaian|pts|pas|uts|uas)\b/i.test(line);
  }

  function matchSoal_(line) {
    var m = String(line || '').match(/^\s*(?:soal\s*)?(\d{1,3})[\.\)\:]\s+(\S.*)$/i);
    if (!m) return null;
    if (/^\d/.test(m[2]) && m[2].indexOf('.') === 1) return null;
    return { n: parseInt(m[1], 10), text: m[2] };
  }

  function matchOpsi_(line) {
    var s = String(line || '');
    var star = /^\s*[\*✓✔●•]\s*/.test(s);
    if (star) s = s.replace(/^\s*[\*✓✔●•]\s*/, '');
    var m = s.match(/^\s*\(?\s*([A-Ea-e])\s*[\)\.\:\]]\s+(\S.*)$/);
    if (!m) return null;
    var body = stripTebal_(m[2]);
    var benar = star || body.bold ||
      /\(\s*(benar|kunci|correct)\s*\)\s*$/i.test(body.text) ||
      /\*\s*$/.test(body.text);
    var text = body.text.replace(/\s*\(\s*(benar|kunci|correct)\s*\)\s*$/i, '').replace(/\s*\*\s*$/, '').trim();
    return { idx: hurufIdx_(m[1]), text: text, benar: benar };
  }

  function pecahOpsiSatuBaris_(line) {
    var s = String(line || '').trim();
    var re = /(?:^|\s)([A-Ea-e])[\.\)]\s+/g;
    var pos = [];
    var m;
    while ((m = re.exec(s))) pos.push({ idx: hurufIdx_(m[1]), start: m.index, end: re.lastIndex });
    if (pos.length < 3) return null;
    var out = [];
    var i;
    for (i = 0; i < pos.length; i++) {
      var from = pos[i].end;
      var to = i + 1 < pos.length ? pos[i + 1].start : s.length;
      var body = stripTebal_(s.substring(from, to));
      if (!body.text) continue;
      out.push({ idx: pos[i].idx, text: body.text, benar: body.bold });
    }
    return out.length >= 2 ? out : null;
  }

  function parseKunciToken_(raw) {
    var s = String(raw || '').toUpperCase().replace(/dan/g, ',').replace(/[^A-E,;\/&]+/g, ' ');
    var out = [];
    var i;
    for (i = 0; i < s.length; i++) {
      var idx = hurufIdx_(s.charAt(i));
      if (idx >= 0 && out.indexOf(idx) === -1) out.push(idx);
    }
    return out;
  }

  function matchKunciBaris_(line) {
    var m = String(line || '').match(/^\s*(\d{1,3})[\.\)\:\s]+([A-Ea-e](?:\s*(?:,|&|\/|dan)\s*[A-Ea-e])*)\s*\.?$/i);
    if (!m) m = String(line || '').match(/^\s*(\d{1,3})\s*[:.\-]\s*([A-E]{1,5})\s*$/i);
    if (!m) return null;
    return { n: parseInt(m[1], 10), idx: parseKunciToken_(m[2]) };
  }

  function matchJawabanInline_(line) {
    var m = String(line || '').match(/^\s*(?:kunci(?:\s+jawaban)?|jawaban|answer)\s*[:.\-]\s*(.+)$/i);
    return m ? m[1].trim() : '';
  }

  function matchPembahasan_(line) {
    var m = String(line || '').match(/^\s*(?:pembahasan|penjelasan|alasan|rationale)\s*[:.\-]\s*(.*)$/i);
    return m ? m[1] : null;
  }

  function tipeDari_(q) {
    if (q.options.length >= 2) {
      return q.correctIdx.length > 1 ? 'pg_kompleks' : 'pg';
    }
    var t = String(q.text || '');
    if (/\.{3,}|_{3,}|isian/i.test(t)) return 'isian';
    if (/(jelaskan|uraikan|mengapa|bagaimana|analisis|sebutkan|berikan alasan|uraian|essay)/i.test(t)) return 'essay';
    return q.answerText ? 'isian' : 'essay';
  }

  function soalBaru_(n, text, stimulus, poin) {
    var st = stripTebal_(text);
    return {
      n: n,
      type: 'pg',
      text: st.text,
      stimulus: stimulus || '',
      pakaiStimulus: !!(stimulus && String(stimulus).trim()),
      options: [],
      correctIdx: [],
      answerText: '',
      points: poin,
      level: '',
      explanation: '',
      warning: ''
    };
  }

  function finalize_(q) {
    if (!q) return null;
    q.type = tipeDari_(q);
    if (q.type === 'pg' || q.type === 'pg_kompleks' || q.type === 'dropdown') {
      if (!q.correctIdx.length && q.options.length) q.correctIdx = [0];
      if (q.correctIdx.length > 1) q.type = 'pg_kompleks';
    } else {
      q.options = q.options.length ? q.options : (q.answerText ? [q.answerText] : []);
      if (q.answerText && !q.options.length) q.options = [q.answerText];
    }
    q.pakaiStimulus = !!(q.stimulus && String(q.stimulus).trim());
    return q.text ? q : null;
  }

  function parseTeks_(teks, poin) {
    var lines = String(teks).split('\n');
    var questions = [];
    var current = null;
    var wacana = '';
    var mode = 'body';
    var kunciMap = {};

    function flush() {
      var q = finalize_(current);
      if (q) questions.push(q);
      current = null;
    }

    var li;
    for (li = 0; li < lines.length; li++) {
      var raw = lines[li];
      var line = String(raw || '').replace(/[ \t]+/g, ' ').trim();
      if (!line) continue;

      if (isKunciHeader_(line)) { flush(); mode = 'kunci'; continue; }
      if (mode === 'kunci') {
        var kb = matchKunciBaris_(line);
        if (kb) kunciMap[kb.n] = kb.idx;
        continue;
      }

      if (isSkip_(line) && !current) continue;

      if (isWacanaHeader_(line)) {
        flush();
        var sisa = line.replace(/^\s*(wacana|bacaan|stimulus|paparan|teks|cerita|passage)[^:]*[:.\-]?\s*/i, '').trim();
        wacana = sisa;
        continue;
      }

      var qs = matchSoal_(line);
      if (qs) {
        flush();
        current = soalBaru_(qs.n, qs.text, wacana, poin);
        var satu = pecahOpsiSatuBaris_(qs.text);
        if (satu) {
          current.text = qs.text.replace(/\s+[A-Ea-e][\.\)]\s+[\s\S]*$/, '').trim() || current.text;
          satu.forEach(function (op) {
            while (current.options.length <= op.idx) current.options.push('');
            current.options[op.idx] = op.text;
            if (op.benar) current.correctIdx.push(op.idx);
          });
        }
        continue;
      }

      var ops = matchOpsi_(line);
      if (ops && current) {
        while (current.options.length <= ops.idx) current.options.push('');
        current.options[ops.idx] = ops.text;
        if (ops.benar && current.correctIdx.indexOf(ops.idx) === -1) current.correctIdx.push(ops.idx);
        continue;
      }

      var banyak = pecahOpsiSatuBaris_(line);
      if (banyak && current) {
        banyak.forEach(function (op) {
          while (current.options.length <= op.idx) current.options.push('');
          current.options[op.idx] = op.text;
          if (op.benar) current.correctIdx.push(op.idx);
        });
        continue;
      }

      var pemb = matchPembahasan_(line);
      if (pemb !== null && current) {
        current.explanation = (current.explanation ? current.explanation + '\n' : '') + pemb;
        continue;
      }

      var jaw = matchJawabanInline_(line);
      if (jaw && current) {
        var idxs = parseKunciToken_(jaw);
        if (idxs.length && current.options.length) {
          current.correctIdx = idxs.filter(function (x) { return x < current.options.length; });
        } else {
          current.answerText = stripTebal_(jaw).text;
        }
        continue;
      }

      if (!current) {
        wacana = wacana ? (wacana + '\n' + line) : line;
        continue;
      }
      if (current.options.length) {
        current.options[current.options.length - 1] += ' ' + stripTebal_(line).text;
      } else {
        current.text += '\n' + stripTebal_(line).text;
      }
    }
    flush();

    Object.keys(kunciMap).forEach(function (nk) {
      var n = Number(nk);
      var q = null;
      var i;
      for (i = 0; i < questions.length; i++) {
        if (questions[i].n === n) { q = questions[i]; break; }
      }
      if (!q || !kunciMap[nk].length) return;
      q.correctIdx = kunciMap[nk].filter(function (x) { return x < (q.options.length || 99); });
      if (q.options.length >= 2) q.type = q.correctIdx.length > 1 ? 'pg_kompleks' : 'pg';
    });

    return questions;
  }

  return {
    parse: parse,
    parseTeks_: parseTeks_,
    xmlToText_: xmlToText_
  };
})();
