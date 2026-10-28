/*
 * MAIL ÖN KONTROL — Outlook "Smart Alerts" eklentisi
 * ISO/IEC 27001:2022 A.5.14 Bilgi transferi / A.8.12 Veri sızıntısını önleme
 *
 * Kullanıcı "Gönder"e bastığında e-postanın konusunu, metnini ve eklerini tarar:
 *   - TR ve yabancı IBAN (mod-97 doğrulamalı)
 *   - TC Kimlik No (resmi sağlama algoritmalı)
 *   - Kredi kartı numarası (Luhn doğrulamalı)
 *   - Gizlilik ibareleri (GİZLİ, HİZMETE ÖZEL vb.)
 * Desteklenen ekler: .docx .xlsx .pptx (ve makrolu sürümleri), .pdf (metin içerenler),
 * .txt .csv .xml .html .json vb., .zip (içindekiler dahil).
 *
 * ÖNEMLİ: Klasik Outlook (Windows) bu dosyayı tek başına çalıştırır; import veya harici
 * kütüphane kullanılamaz. Bu yüzden ZIP açma, base64 ve metin çözme burada yazılıdır.
 */

/* =====================================================================
 * AYARLAR — kuruluşa göre düzenleyin
 * ===================================================================== */
var AYARLAR = {
  // Kuruluşun kendi alan adları. Tüm alıcılar bu alan adlarındaysa tarama yapılmaz.
  // Boş bırakılırsa her e-posta taranır. Örnek: ["firma.com.tr", "firma.com"]
  IC_ALAN_ADLARI: [],

  // true : Hassas veri bulunursa kullanıcı düzeltmeden gönderemez.
  // false: Uyarı gösterilir, kullanıcı "Yine de Gönder" diyebilir (kayıt başlığı eklenir).
  BULGUDA_ENGELLE: true,

  // Taranamayan ekler (görsel, parolalı dosya, taranmış PDF, eski .doc/.xls vb.) için
  // "Dosyanız güvenli mi?" sorusu sorulsun mu?
  TARANAMAYAN_EKTE_SOR: true,

  // true: Tarama temiz olsa bile, ekli ve kuruluş dışına giden her e-postada onay sorulur.
  HER_DIS_GONDERIMDE_SOR: false,

  // Aranacak gizlilik ibareleri (küçük harfle, tam kelime olarak aranır)
  ANAHTAR_KELIMELER: ["gizli", "çok gizli", "hizmete özel", "kişiye özel", "ticari sır"],

  // Bu boyuttan büyük ekler taranmaz, "taranamadı" sayılır (MB)
  MAKS_EK_MB: 15
};

/* =====================================================================
 * BAYT / METİN YARDIMCILARI
 * ===================================================================== */
function Taranamadi(mesaj) {
  this.message = mesaj;
  this.taranamadi = true;
}

var B64_TABLO = (function () {
  var t = new Int16Array(256);
  for (var i = 0; i < 256; i++) t[i] = -1;
  var a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (var j = 0; j < a.length; j++) t[a.charCodeAt(j)] = j;
  return t;
})();

function base64Coz(s) {
  var out = new Uint8Array(Math.floor((s.length * 3) / 4) + 3);
  var j = 0, buf = 0, bits = 0;
  for (var i = 0; i < s.length; i++) {
    var v = B64_TABLO[s.charCodeAt(i) & 255];
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (buf >> bits) & 255;
      buf &= (1 << bits) - 1;
    }
  }
  return out.subarray(0, j);
}

function latin1(b) {
  var parca = [], adim = 8192;
  for (var i = 0; i < b.length; i += adim) {
    parca.push(String.fromCharCode.apply(null, Array.prototype.slice.call(b.subarray(i, i + adim))));
  }
  return parca.join("");
}

// Katı UTF-8 çözücü: geçersiz dizide null döner
function utf8Coz(b, kati) {
  var out = [], i = 0, n = b.length;
  if (n >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  while (i < n) {
    var c = b[i++], kod, ek;
    if (c < 0x80) { out.push(c); continue; }
    else if (c >= 0xc2 && c < 0xe0) { kod = c & 0x1f; ek = 1; }
    else if (c >= 0xe0 && c < 0xf0) { kod = c & 0x0f; ek = 2; }
    else if (c >= 0xf0 && c < 0xf5) { kod = c & 0x07; ek = 3; }
    else { if (kati) return null; out.push(0xfffd); continue; }
    var gecerli = true;
    for (var k = 0; k < ek; k++) {
      if (i >= n || (b[i] & 0xc0) !== 0x80) { gecerli = false; break; }
      kod = (kod << 6) | (b[i++] & 0x3f);
    }
    if (!gecerli) { if (kati) return null; out.push(0xfffd); continue; }
    out.push(kod);
  }
  var s = [];
  for (var x = 0; x < out.length; x += 8192) s.push(String.fromCodePoint.apply(null, out.slice(x, x + 8192)));
  return s.join("");
}

var CP1254 = { 0xd0: "Ğ", 0xdd: "İ", 0xde: "Ş", 0xf0: "ğ", 0xfd: "ı", 0xfe: "ş" };
function cp1254Coz(b) {
  var s = "";
  for (var i = 0; i < b.length; i++) s += CP1254[b[i]] || String.fromCharCode(b[i]);
  return s;
}

function metinCoz(b) {
  var s = utf8Coz(b, true);
  return s === null ? cp1254Coz(b) : s;
}

function htmlVarlikCoz(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCodePoint(parseInt(d, 10)); })
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

/* =====================================================================
 * DEFLATE (RFC 1951) ÇÖZÜCÜ — ZIP ve PDF için
 * ===================================================================== */
var L_TABAN = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
var L_EK = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
var D_TABAN = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
var D_EK = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
var KL_SIRA = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

function huffmanKur(uzunluklar) {
  var sayac = new Uint16Array(16), konum = new Uint16Array(16), sembol = new Uint16Array(uzunluklar.length);
  for (var i = 0; i < uzunluklar.length; i++) sayac[uzunluklar[i]]++;
  sayac[0] = 0;
  for (var l = 1; l < 15; l++) konum[l + 1] = konum[l] + sayac[l];
  for (var s = 0; s < uzunluklar.length; s++) if (uzunluklar[s]) sembol[konum[uzunluklar[s]]++] = s;
  return { sayac: sayac, sembol: sembol };
}

var SABIT_LIT = (function () {
  var u = new Uint8Array(288), i;
  for (i = 0; i < 144; i++) u[i] = 8;
  for (; i < 256; i++) u[i] = 9;
  for (; i < 280; i++) u[i] = 7;
  for (; i < 288; i++) u[i] = 8;
  return huffmanKur(u);
})();
var SABIT_MES = (function () {
  var u = new Uint8Array(30);
  for (var i = 0; i < 30; i++) u[i] = 5;
  return huffmanKur(u);
})();

function inflateRaw(veri, beklenen) {
  var poz = 0, bitTampon = 0, bitSay = 0;
  var cikti = new Uint8Array(Math.max(beklenen || 0, veri.length * 4, 1024)), cp = 0;

  function bit(n) {
    while (bitSay < n) {
      if (poz >= veri.length) throw new Error("Beklenmeyen veri sonu");
      bitTampon |= veri[poz++] << bitSay;
      bitSay += 8;
    }
    var v = bitTampon & ((1 << n) - 1);
    bitTampon >>>= n;
    bitSay -= n;
    return v;
  }
  function yer(n) {
    if (cp + n <= cikti.length) return;
    var yeni = new Uint8Array(Math.max(cikti.length * 2, cp + n));
    yeni.set(cikti.subarray(0, cp));
    cikti = yeni;
  }
  function coz(h) {
    var kod = 0, ilk = 0, indeks = 0;
    for (var uz = 1; uz < 16; uz++) {
      kod |= bit(1);
      var adet = h.sayac[uz];
      if (kod - adet < ilk) return h.sembol[indeks + (kod - ilk)];
      indeks += adet;
      ilk += adet;
      ilk <<= 1;
      kod <<= 1;
    }
    throw new Error("Geçersiz Huffman kodu");
  }
  function blok(lit, mes) {
    for (;;) {
      var s = coz(lit);
      if (s < 256) { yer(1); cikti[cp++] = s; }
      else if (s === 256) return;
      else {
        s -= 257;
        if (s >= 29) throw new Error("Geçersiz uzunluk");
        var uzun = L_TABAN[s] + bit(L_EK[s]);
        var ds = coz(mes);
        var mesafe = D_TABAN[ds] + bit(D_EK[ds]);
        if (mesafe > cp) throw new Error("Geçersiz mesafe");
        yer(uzun);
        for (var k = 0; k < uzun; k++, cp++) cikti[cp] = cikti[cp - mesafe];
      }
    }
  }

  var son;
  do {
    son = bit(1);
    var tur = bit(2);
    if (tur === 0) {
      bitTampon = 0; bitSay = 0;
      if (poz + 4 > veri.length) throw new Error("Bozuk blok");
      var len = veri[poz] | (veri[poz + 1] << 8);
      poz += 4;
      yer(len);
      cikti.set(veri.subarray(poz, poz + len), cp);
      cp += len; poz += len;
    } else if (tur === 1) {
      blok(SABIT_LIT, SABIT_MES);
    } else if (tur === 2) {
      var hlit = bit(5) + 257, hdist = bit(5) + 1, hclen = bit(4) + 4;
      var kl = new Uint8Array(19);
      for (var i = 0; i < hclen; i++) kl[KL_SIRA[i]] = bit(3);
      var klH = huffmanKur(kl);
      var uzl = new Uint8Array(hlit + hdist), j = 0;
      while (j < hlit + hdist) {
        var sm = coz(klH);
        if (sm < 16) uzl[j++] = sm;
        else {
          var tekrar, deger = 0;
          if (sm === 16) { if (j === 0) throw new Error("Bozuk kod"); deger = uzl[j - 1]; tekrar = 3 + bit(2); }
          else if (sm === 17) tekrar = 3 + bit(3);
          else tekrar = 11 + bit(7);
          while (tekrar--) uzl[j++] = deger;
        }
      }
      blok(huffmanKur(uzl.subarray(0, hlit)), huffmanKur(uzl.subarray(hlit)));
    } else throw new Error("Geçersiz blok türü");
  } while (!son);
  return cikti.subarray(0, cp);
}

/* =====================================================================
 * ZIP OKUYUCU (Office dosyaları da ZIP'tir)
 * ===================================================================== */
function u16(b, i) { return b[i] | (b[i + 1] << 8); }
function u32(b, i) { return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; }

function zipGirdileri(b) {
  var eocd = -1;
  for (var i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Taranamadi("Parolalı veya bozuk dosya");
  var adet = u16(b, eocd + 10), poz = u32(b, eocd + 16), girdiler = [];
  for (var k = 0; k < adet; k++) {
    if (u32(b, poz) !== 0x02014b50) throw new Taranamadi("Bozuk ZIP dizini");
    var bayrak = u16(b, poz + 8), yontem = u16(b, poz + 10);
    var sikisik = u32(b, poz + 20), acik = u32(b, poz + 24);
    var adUz = u16(b, poz + 28), ekUz = u16(b, poz + 30), yorumUz = u16(b, poz + 32);
    var yerel = u32(b, poz + 42);
    var ad = utf8Coz(b.subarray(poz + 46, poz + 46 + adUz), false);
    girdiler.push({ ad: ad, bayrak: bayrak, yontem: yontem, sikisik: sikisik, acik: acik, yerel: yerel });
    poz += 46 + adUz + ekUz + yorumUz;
  }
  return girdiler;
}

function zipOku(b, g) {
  if (g.bayrak & 1) throw new Taranamadi("Parolalı arşiv içeriği: " + g.ad);
  var bas = g.yerel + 30 + u16(b, g.yerel + 26) + u16(b, g.yerel + 28);
  var veri = b.subarray(bas, bas + g.sikisik);
  if (g.yontem === 0) return veri;
  if (g.yontem === 8) return inflateRaw(veri, g.acik);
  throw new Taranamadi("Desteklenmeyen sıkıştırma: " + g.ad);
}

/* =====================================================================
 * DOSYA TÜRLERİNE GÖRE METİN ÇIKARMA
 * ===================================================================== */
var METIN_UZ = ["txt", "csv", "log", "json", "xml", "html", "htm", "md", "tsv", "ini", "sql", "eml"];
var OFFICE_UZ = ["docx", "docm", "xlsx", "xlsm", "pptx", "pptm", "dotx", "xltx", "potx"];
var GORSEL_UZ = ["jpg", "jpeg", "png", "gif", "bmp", "tif", "tiff", "heic", "webp"];

function uzanti(ad) {
  var m = /\.([^.\/\\]+)$/.exec(ad || "");
  return m ? m[1].toLowerCase() : "";
}

function xmlMetin(x) {
  x = x.replace(/<f\b[^>]*\/>/g, "").replace(/<f\b[^>]*>[\s\S]*?<\/f>/g, "");
  x = x.replace(/<w:tab\/>|<w:br\/>|<a:br\/>/g, " ");
  x = x.replace(/<\/(w:p|w:tc|a:p|c|si|row|is)>/g, "\n");
  x = x.replace(/<[^>]+>/g, "");
  x = htmlVarlikCoz(x);
  return x.replace(/\b\d\.\d+E\+\d{1,2}\b/g, function (m) {
    var v = Number(m);
    return Number.isInteger(v) ? v.toFixed(0) : m;
  });
}

function officeMetin(b) {
  var parcalar = [];
  zipGirdileri(b).forEach(function (g) {
    if (!/\.xml$/.test(g.ad)) return;
    if (!/^(word\/|xl\/sharedStrings|xl\/worksheets\/|xl\/comments|ppt\/slides\/|ppt\/notesSlides\/|docProps\/core)/.test(g.ad)) return;
    parcalar.push(xmlMetin(utf8Coz(zipOku(b, g), false)));
  });
  return parcalar.join("\n");
}

function zipMetin(b, derinlik) {
  if (derinlik > 2) throw new Taranamadi("İç içe arşiv derinliği çok fazla");
  var parcalar = [];
  zipGirdileri(b).forEach(function (g) {
    if (/\/$/.test(g.ad)) return;
    try {
      parcalar.push(icerikMetni(g.ad, zipOku(b, g), derinlik + 1));
    } catch (e) {
      if (e.taranamadi) throw new Taranamadi("Arşiv içi '" + g.ad + "': " + e.message);
      throw e;
    }
  });
  return parcalar.join("\n");
}

/* ---------- PDF ---------- */
function ascii85Coz(b) {
  var s = latin1(b), out = [], grup = [];
  var bas = s.indexOf("<~");
  if (bas >= 0) s = s.slice(bas + 2);
  var son = s.indexOf("~>");
  if (son >= 0) s = s.slice(0, son);
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c === 122 && grup.length === 0) { out.push(0, 0, 0, 0); continue; } // 'z'
    if (c < 33 || c > 117) continue;
    grup.push(c - 33);
    if (grup.length === 5) {
      var v = (((grup[0] * 85 + grup[1]) * 85 + grup[2]) * 85 + grup[3]) * 85 + grup[4];
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      grup = [];
    }
  }
  if (grup.length > 1) {
    var eksik = 5 - grup.length;
    while (grup.length < 5) grup.push(84);
    var w = (((grup[0] * 85 + grup[1]) * 85 + grup[2]) * 85 + grup[3]) * 85 + grup[4];
    var bayt = [(w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255];
    for (var k = 0; k < 4 - eksik; k++) out.push(bayt[k]);
  }
  return new Uint8Array(out);
}

function pdfFiltrele(veri, sozluk) {
  var f = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(sozluk);
  if (!f) return veri;
  var adlar = f[1].match(/\/[A-Za-z0-9]+/g) || [];
  for (var i = 0; i < adlar.length; i++) {
    var a = adlar[i];
    if (a === "/FlateDecode" || a === "/Fl") veri = inflateRaw(veri.subarray(2));
    else if (a === "/ASCII85Decode" || a === "/A85") veri = ascii85Coz(veri);
    else return null; // görsel vb. desteklenmeyen filtre
  }
  return veri;
}

function pdfNesneleri(b, s) {
  var nesneler = {}, re = /(\d+)\s+\d+\s+obj\b/g, m;
  while ((m = re.exec(s))) {
    var bas = m.index + m[0].length, son = s.indexOf("endobj", bas);
    if (son < 0) son = s.length;
    var govde = s.slice(bas, son), n = { sozluk: govde, veri: null };
    var sp = govde.search(/stream\r?\n/);
    if (sp >= 0) {
      n.sozluk = govde.slice(0, sp);
      var vb = bas + sp + /stream\r?\n/.exec(govde.slice(sp))[0].length;
      var ve = s.indexOf("endstream", vb);
      n.veri = b.subarray(vb, ve < 0 ? son : ve);
    }
    nesneler[m[1]] = n;
    re.lastIndex = son;
  }
  // Sıkıştırılmış nesne akışları (ObjStm)
  Object.keys(nesneler).forEach(function (k) {
    var n = nesneler[k];
    if (!n.veri || !/\/Type\s*\/ObjStm/.test(n.sozluk)) return;
    try {
      var acik = latin1(pdfFiltrele(n.veri, n.sozluk));
      var ilk = +(/\/First\s+(\d+)/.exec(n.sozluk) || [0, 0])[1];
      var basliklar = acik.slice(0, ilk).trim().split(/\s+/).map(Number);
      for (var i = 0; i + 1 < basliklar.length; i += 2) {
        var bitis = i + 3 < basliklar.length ? ilk + basliklar[i + 3] : acik.length;
        if (!nesneler[basliklar[i]]) nesneler[basliklar[i]] = { sozluk: acik.slice(ilk + basliklar[i + 1], bitis), veri: null };
      }
    } catch (e) { /* atla */ }
  });
  return nesneler;
}

function hexBayt(h) {
  h = h.replace(/[^0-9A-Fa-f]/g, "");
  if (h.length % 2) h += "0";
  var s = "";
  for (var i = 0; i < h.length; i += 2) s += String.fromCharCode(parseInt(h.substr(i, 2), 16));
  return s;
}

function utf16beMetin(bayt) {
  var s = "";
  for (var i = 0; i + 1 < bayt.length; i += 2) s += String.fromCharCode((bayt.charCodeAt(i) << 8) | bayt.charCodeAt(i + 1));
  return s;
}

function cmapCoz(metin) {
  var cmap = { bayt: 1, harita: {} }, m;
  var cs = /begincodespacerange\s*<([0-9A-Fa-f]+)>/.exec(metin);
  if (cs) cmap.bayt = Math.max(1, cs[1].length / 2);
  var reBlok = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = reBlok.exec(metin))) {
    var reCift = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g, c;
    while ((c = reCift.exec(m[1]))) cmap.harita[parseInt(c[1], 16)] = utf16beMetin(hexBayt(c[2]));
  }
  var reAralik = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = reAralik.exec(metin))) {
    var reA = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])/g, a;
    while ((a = reA.exec(m[1]))) {
      var alt = parseInt(a[1], 16), ust = parseInt(a[2], 16);
      if (ust - alt > 65535) continue;
      if (a[3][0] === "[") {
        var liste = a[3].match(/<[0-9A-Fa-f]*>/g) || [];
        for (var i = 0; i < liste.length && alt + i <= ust; i++) cmap.harita[alt + i] = utf16beMetin(hexBayt(liste[i]));
      } else {
        var hedef = hexBayt(a[3]);
        var temel = utf16beMetin(hedef), sonKod = temel.charCodeAt(temel.length - 1), onEk = temel.slice(0, -1);
        for (var k = alt; k <= ust; k++) cmap.harita[k] = onEk + String.fromCharCode(sonKod + (k - alt));
      }
    }
  }
  return cmap;
}

function pdfYaziTipleri(nesneler) {
  var cmapOnbellek = {}, yaziTipleri = {};
  function cmapGetir(fontNo) {
    if (cmapOnbellek.hasOwnProperty(fontNo)) return cmapOnbellek[fontNo];
    var sonuc = null, f = nesneler[fontNo];
    var tu = f && /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(f.sozluk);
    if (tu && nesneler[tu[1]] && nesneler[tu[1]].veri) {
      try { sonuc = cmapCoz(latin1(pdfFiltrele(nesneler[tu[1]].veri, nesneler[tu[1]].sozluk))); } catch (e) { sonuc = null; }
    } else if (f && /\/Identity-H/.test(f.sozluk)) {
      sonuc = { bayt: 2, harita: {}, eksik: true };
    }
    cmapOnbellek[fontNo] = sonuc;
    return sonuc;
  }
  function ciftleriOku(icerik) {
    var re = /\/([^\s\/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g, m;
    while ((m = re.exec(icerik))) yaziTipleri[m[1]] = cmapGetir(m[2]);
  }
  Object.keys(nesneler).forEach(function (k) {
    var soz = nesneler[k].sozluk, re = /\/Font\s*(<<([\s\S]*?)>>|(\d+)\s+\d+\s+R)/g, m;
    while ((m = re.exec(soz))) {
      if (m[2] !== undefined) ciftleriOku(m[2]);
      else if (nesneler[m[3]]) ciftleriOku(nesneler[m[3]].sozluk);
    }
  });
  return yaziTipleri;
}

function pdfIcerikMetni(c, yaziTipleri, sayac) {
  if (c.indexOf("BT") < 0) return "";
  var out = [], i = 0, n = c.length, sonAd = null, cmap = null;
  var kacis = { n: "\n", r: "\r", t: "\t", b: "", f: "" };
  function dizeEkle(bayt) {
    var t = "";
    if (cmap && !cmap.eksik) {
      for (var k = 0; k + cmap.bayt <= bayt.length; k += cmap.bayt) {
        var kod = 0;
        for (var q = 0; q < cmap.bayt; q++) kod = kod * 256 + bayt.charCodeAt(k + q);
        var h = cmap.harita[kod];
        t += h !== undefined ? h : (cmap.bayt === 1 ? bayt[k] : "");
      }
    } else if (cmap && cmap.eksik) {
      sayac.okunamayan += bayt.length;
      return;
    } else t = bayt;
    sayac.toplam += t.length;
    sayac.okunamayan += (t.match(/[\x00-\x08\x0e-\x1f]/g) || []).length;
    out.push(t);
  }
  while (i < n) {
    var ch = c[i];
    if (ch === "(") {
      var derin = 1, s = "";
      i++;
      while (i < n && derin > 0) {
        var x = c[i];
        if (x === "\\") {
          var y = c[i + 1];
          if (y >= "0" && y <= "7") {
            var o = /^[0-7]{1,3}/.exec(c.substr(i + 1, 3))[0];
            s += String.fromCharCode(parseInt(o, 8) & 255);
            i += 1 + o.length;
            continue;
          }
          if (y === "\r" || y === "\n") { i += 2; continue; }
          s += Object.prototype.hasOwnProperty.call(kacis, y) ? kacis[y] : y;
          i += 2;
          continue;
        }
        if (x === "(") derin++;
        else if (x === ")") { derin--; if (derin === 0) { i++; break; } }
        s += x;
        i++;
      }
      dizeEkle(s);
      continue;
    }
    if (ch === "<" && c[i + 1] !== "<") {
      var j = c.indexOf(">", i);
      if (j < 0) break;
      dizeEkle(hexBayt(c.slice(i + 1, j)));
      i = j + 1;
      continue;
    }
    if (ch === "/") {
      var ad = /^\/([^\s\/<>\[\]()]*)/.exec(c.substr(i, 128));
      sonAd = ad[1];
      i += ad[0].length;
      continue;
    }
    if (/[A-Za-z'"*]/.test(ch)) {
      var op = /^[A-Za-z'"*]+/.exec(c.substr(i, 8))[0];
      if (op === "Tf") cmap = yaziTipleri.hasOwnProperty(sonAd) ? yaziTipleri[sonAd] : null;
      else if (op === "Td" || op === "TD" || op === "T*" || op === "Tm" || op === "'" || op === '"') out.push(" ");
      else if (op === "ET") out.push("\n");
      i += op.length;
      continue;
    }
    i++;
  }
  return out.join("");
}

function pdfMetin(b) {
  var s = latin1(b);
  if (/\/Encrypt\b/.test(s)) throw new Taranamadi("Parolalı PDF");
  var nesneler = pdfNesneleri(b, s), yaziTipleri = pdfYaziTipleri(nesneler);
  var sayac = { toplam: 0, okunamayan: 0 }, parcalar = [];
  Object.keys(nesneler).forEach(function (k) {
    var nes = nesneler[k];
    if (!nes.veri) return;
    if (/\/Subtype\s*\/Image|\/Type\s*\/(ObjStm|XRef|Metadata)|\/Length[123]\b|\/Subtype\s*\/(Type1C|CIDFontType0C|OpenType)/.test(nes.sozluk)) return;
    var acik;
    try { acik = pdfFiltrele(nes.veri, nes.sozluk); } catch (e) { return; }
    if (!acik) return;
    var icerik = latin1(acik);
    if (icerik.indexOf("begincmap") >= 0) return;
    parcalar.push(pdfIcerikMetni(icerik, yaziTipleri, sayac));
  });
  var metin = parcalar.join("\n");
  if (metin.replace(/\s/g, "").length < 20 || sayac.okunamayan > sayac.toplam * 0.3) {
    throw new Taranamadi("PDF'ten metin okunamadı (taranmış/görsel PDF olabilir)");
  }
  return metin;
}

function icerikMetni(ad, b, derinlik) {
  var uz = uzanti(ad);
  if (METIN_UZ.indexOf(uz) >= 0) {
    var t = metinCoz(b);
    if (uz === "html" || uz === "htm" || uz === "xml") t = htmlVarlikCoz(t.replace(/<[^>]+>/g, " "));
    return t;
  }
  if (OFFICE_UZ.indexOf(uz) >= 0) return officeMetin(b);
  if (uz === "pdf") return pdfMetin(b);
  if (uz === "zip") return zipMetin(b, derinlik || 0);
  if (uz === "doc" || uz === "xls" || uz === "ppt") throw new Taranamadi("eski Office biçimi");
  if (GORSEL_UZ.indexOf(uz) >= 0) throw new Taranamadi("görsel dosya");
  throw new Taranamadi("desteklenmeyen dosya türü" + (uz ? " (." + uz + ")" : ""));
}

/* =====================================================================
 * HASSAS VERİ DEDEKTÖRLERİ
 * ===================================================================== */
function sadeles(s) { return s.replace(/[\s\-]/g, "").toUpperCase(); }

function ibanGecerli(iban) {
  iban = sadeles(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  if (iban.indexOf("TR") === 0 && iban.length !== 26) return false;
  var d = iban.slice(4) + iban.slice(0, 4), kalan = 0;
  for (var i = 0; i < d.length; i++) {
    var v = parseInt(d[i], 36), str = String(v);
    for (var k = 0; k < str.length; k++) kalan = (kalan * 10 + (str.charCodeAt(k) - 48)) % 97;
  }
  return kalan === 1;
}

function tcknGecerli(no) {
  if (!/^[1-9]\d{10}$/.test(no)) return false;
  var d = no.split("").map(Number);
  var tek = d[0] + d[2] + d[4] + d[6] + d[8], cift = d[1] + d[3] + d[5] + d[7];
  if ((((tek * 7 - cift) % 10) + 10) % 10 !== d[9]) return false;
  var top = 0;
  for (var i = 0; i < 10; i++) top += d[i];
  return top % 10 === d[10];
}

function luhnGecerli(no) {
  var top = 0;
  for (var i = 0; i < no.length; i++) {
    var n = +no[no.length - 1 - i];
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    top += n;
  }
  return top % 10 === 0;
}

function maskele(deger, bas, son) {
  var t = sadeles(deger);
  return t.slice(0, bas) + new Array(Math.max(t.length - bas - son, 0) + 1).join("*") + t.slice(t.length - son);
}

function bosluk(n) { return new Array(n + 1).join(" "); }
function trKucuk(s) { return s.replace(/I/g, "ı").replace(/İ/g, "i").toLowerCase(); }
function trBuyuk(s) { return s.replace(/i/g, "İ").replace(/ı/g, "I").toUpperCase(); }
function regexKacis(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function taraMetin(metin) {
  var bulgular = [], gorulen = {};
  function ekle(tur, ham, maskeli) {
    var anahtar = tur + "|" + sadeles(ham);
    if (gorulen[anahtar]) return;
    gorulen[anahtar] = true;
    bulgular.push({ tur: tur, deger: maskeli });
  }

  // 1) TR IBAN — bulunup metinden silinir (rakamları TCKN/kart olarak tekrar sayılmasın)
  metin = metin.replace(/(^|[^A-Za-z0-9])(TR[ \-]?\d{2}(?:[ \-]?\d{4}){5}[ \-]?\d{2})(?!\d)/gi, function (m, on, iban) {
    if (!ibanGecerli(iban)) return m;
    ekle("TR IBAN", iban, maskele(iban, 4, 2));
    return on + bosluk(iban.length);
  });

  // 2) Yabancı IBAN (yalnızca ASCII harfler büyütülür, metin uzunluğu korunur)
  var buyuk = metin.replace(/[a-z]/g, function (c) { return c.toUpperCase(); });
  var reIban = /(^|[^A-Za-z0-9])([A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?)(?![A-Za-z0-9])/g, m;
  var silinecek = [];
  while ((m = reIban.exec(buyuk))) {
    if (ibanGecerli(m[2])) {
      ekle("Yabancı IBAN", m[2], maskele(m[2], 4, 2));
      silinecek.push([m.index + m[1].length, m[2].length]);
    }
  }
  silinecek.forEach(function (s) { metin = metin.slice(0, s[0]) + bosluk(s[1]) + metin.slice(s[0] + s[1]); });

  // 3) TC Kimlik No
  var reTc = /(^|\D)([1-9]\d{10})(?!\d)/g;
  while ((m = reTc.exec(metin))) {
    if (tcknGecerli(m[2])) ekle("TC Kimlik No", m[2], maskele(m[2], 3, 2));
  }

  // 4) Kredi kartı
  var reKart = /(^|\D)([3-6]\d(?:[ \-]?\d){11,17})(?![ \-]?\d)/g;
  while ((m = reKart.exec(metin))) {
    var rakam = m[2].replace(/\D/g, "");
    if (rakam.length >= 13 && rakam.length <= 19 && luhnGecerli(rakam)) ekle("Kredi kartı no", rakam, maskele(rakam, 4, 4));
  }

  // 5) Gizlilik ibareleri (tam kelime)
  var kucuk = trKucuk(metin), harf = "a-z0-9_çğıöşüâîû";
  AYARLAR.ANAHTAR_KELIMELER.forEach(function (k) {
    var re = new RegExp("(^|[^" + harf + "])" + regexKacis(k) + "(?=$|[^" + harf + "])");
    if (re.test(kucuk)) ekle("Gizlilik ibaresi", k, '"' + trBuyuk(k) + '"');
  });

  return bulgular;
}

/* =====================================================================
 * OUTLOOK OLAY İŞLEYİCİSİ
 * ===================================================================== */
function asenkron(nesne, metot, argumanlar) {
  return new Promise(function (coz, reddet) {
    var a = (argumanlar || []).concat([function (r) {
      if (r.status === Office.AsyncResultStatus.Succeeded) coz(r.value);
      else reddet(r.error || new Error(metot + " başarısız"));
    }]);
    nesne[metot].apply(nesne, a);
  });
}

function icAdres(adres) {
  var alan = (adres.split("@")[1] || "").toLowerCase();
  return AYARLAR.IC_ALAN_ADLARI.some(function (d) {
    d = d.toLowerCase();
    return alan === d || alan.slice(-(d.length + 1)) === "." + d;
  });
}

function denetle() {
  var item = Office.context.mailbox.item;
  var sonuc = { bulgular: [], taranamayan: [], disAlici: 0, ekSayisi: 0 };
  return Promise.all([
    asenkron(item.to, "getAsync"),
    asenkron(item.cc, "getAsync"),
    asenkron(item.bcc, "getAsync")
  ]).then(function (listeler) {
    var adresler = [].concat(listeler[0] || [], listeler[1] || [], listeler[2] || []).map(function (a) {
      return (a.emailAddress || "").toLowerCase();
    });
    sonuc.disAlici = adresler.filter(function (a) { return !icAdres(a); }).length;
    if (AYARLAR.IC_ALAN_ADLARI.length && sonuc.disAlici === 0) { sonuc.icGonderim = true; return sonuc; }

    return Promise.all([
      asenkron(item.subject, "getAsync"),
      asenkron(item.body, "getAsync", [Office.CoercionType.Text])
    ]).then(function (r) {
      taraMetin((r[0] || "") + "\n" + (r[1] || "")).forEach(function (b) {
        b.yer = "E-posta metni";
        sonuc.bulgular.push(b);
      });
      return asenkron(item, "getAttachmentsAsync");
    }).then(function (ekler) {
      ekler = (ekler || []).filter(function (e) { return !e.isInline; });
      sonuc.ekSayisi = ekler.length;
      return ekler.reduce(function (zincir, ek) {
        return zincir.then(function () {
          if (ek.size > AYARLAR.MAKS_EK_MB * 1024 * 1024) {
            sonuc.taranamayan.push(ek.name + " (" + AYARLAR.MAKS_EK_MB + " MB'tan büyük)");
            return;
          }
          return asenkron(item, "getAttachmentContentAsync", [ek.id]).then(function (icerik) {
            if (!icerik || icerik.format !== "base64") {
              sonuc.taranamayan.push(ek.name + " (bulut eki veya ekli e-posta)");
              return;
            }
            try {
              var metin = icerikMetni(ek.name, base64Coz(icerik.content), 0);
              taraMetin(metin).forEach(function (b) { b.yer = ek.name; sonuc.bulgular.push(b); });
            } catch (e) {
              if (e && e.taranamadi) sonuc.taranamayan.push(ek.name + " (" + e.message + ")");
              else sonuc.taranamayan.push(ek.name + " (okunamadı)");
            }
          });
        });
      }, Promise.resolve());
    }).then(function () { return sonuc; });
  });
}

function kisalt(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + "…"; }

function basligiYaz(deger) {
  try {
    var item = Office.context.mailbox.item;
    if (!item.internetHeaders) return Promise.resolve();
    return asenkron(item.internetHeaders, "setAsync", [{ "X-Mail-On-Kontrol": deger }]).catch(function () {});
  } catch (e) {
    return Promise.resolve();
  }
}

function soruAyari(secenekler) {
  if (Office.context.requirements.isSetSupported("Mailbox", "1.14")) {
    secenekler.sendModeOverride = Office.MailboxEnums.SendModeOverride.PromptUser;
  }
  return secenekler;
}

function sonuclandir(event, s) {
  if (s.icGonderim) {
    event.completed({ allowEvent: true });
    return;
  }
  if (s.bulgular.length) {
    var satirlar = s.bulgular.map(function (b) { return "• " + b.yer + ": " + b.tur + " " + b.deger; });
    var mesaj = AYARLAR.BULGUDA_ENGELLE
      ? "GİZLİ BİLGİ TESPİT EDİLDİ. Göndermeden önce bu bilgileri çıkarın veya maskeleyin:\n"
      : "GİZLİ BİLGİ TESPİT EDİLDİ. Bu bilgileri göndermeye yetkili değilseniz gönderimi iptal edin:\n";
    var opts = { allowEvent: false, errorMessage: kisalt(mesaj + satirlar.join("\n"), 500) };
    if (!AYARLAR.BULGUDA_ENGELLE) soruAyari(opts);
    basligiYaz("BULGU-KULLANICI-ONAYI").then(function () { event.completed(opts); });
    return;
  }
  if (s.taranamayan.length && AYARLAR.TARANAMAYAN_EKTE_SOR) {
    var m = "Şu ek(ler) otomatik taranamadı:\n" +
      s.taranamayan.map(function (t) { return "• " + t; }).join("\n");
    m = kisalt(m, 330) + "\n\nDosyanız güvenli mi? TC Kimlik No, IBAN veya gizli bilgi içermediğinden eminseniz \"Yine de Gönder\"i seçin.";
    basligiYaz("TARANAMAYAN-EK-KULLANICI-ONAYI").then(function () {
      event.completed(soruAyari({ allowEvent: false, errorMessage: kisalt(m, 500) }));
    });
    return;
  }
  if (AYARLAR.HER_DIS_GONDERIMDE_SOR && s.ekSayisi > 0 && s.disAlici > 0) {
    basligiYaz("TEMIZ-KULLANICI-ONAYI").then(function () {
      event.completed(soruAyari({
        allowEvent: false,
        errorMessage: "Ekler tarandı, hassas veri bulunmadı. E-posta kuruluş dışına gönderilecek. Dosyanız güvenli mi? Eminseniz \"Yine de Gönder\"i seçin."
      }));
    });
    return;
  }
  basligiYaz("TEMIZ").then(function () { event.completed({ allowEvent: true }); });
}

function onMessageSendHandler(event) {
  denetle()
    .then(function (s) { sonuclandir(event, s); })
    .catch(function (e) {
      event.completed(soruAyari({
        allowEvent: false,
        errorMessage: kisalt("Mail Ön Kontrol taramayı tamamlayamadı (" + ((e && e.message) || "bilinmeyen hata") +
          "). Dosyanızın gizli bilgi içermediğinden eminseniz \"Yine de Gönder\"i seçin.", 500)
      }));
    });
}

// Manifest'teki FunctionName ile JavaScript işlevini eşler (zorunlu)
if (typeof Office !== "undefined" && Office.actions) {
  Office.actions.associate("onMessageSendHandler", onMessageSendHandler);
}

// Yalnızca test ortamı (Node.js) için
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    taraMetin: taraMetin, icerikMetni: icerikMetni, inflateRaw: inflateRaw, base64Coz: base64Coz,
    onMessageSendHandler: onMessageSendHandler, AYARLAR: AYARLAR
  };
}
