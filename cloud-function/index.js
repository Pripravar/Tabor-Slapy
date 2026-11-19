/* ════════════════════════════════════════════════════════════════
   CLOUD FUNCTION – odesílání push notifikací (II/137 Slapy – Tábor)
   - Sleduje /notifikace_fronta v Realtime Database (europe-west1)
   - Pro každý nový záznam pošle FCM zprávu příjemcům, pak záznam smaže
   - BEZ secretů (jen FCM) – upload funkce tu nejsou (soubory jdou přes Storage SDK)

   DEPLOY (v této složce cloud-function):
       npm install
       firebase login --reauth        (jednou, otevře prohlížeč – Ondřej)
       firebase deploy --only functions
   POŽADAVKY: Firebase plán Blaze (Tábor ho má). Free tier pokryje stovky notifikací/den.
   ════════════════════════════════════════════════════════════════ */

// firebase-functions v6 vyžaduje explicitní /v1 import pro starší API (.ref().onCreate())
const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.database();

// Funkce musí běžet ve stejné oblasti jako Realtime DB (europe-west1).
exports.sendTaskNotifications = functions
  .region('europe-west1')
  .database
  .ref('/notifikace_fronta/{id}')
  .onCreate(async (snap, context) => {
    const rec = snap.val();
    if(!rec) return null;

    let title = 'II/137 Slapy – Tábor';
    let body  = '';
    let recipientUids = [];

    if(rec.typ === 'novy') {
      title = '✅ Nový úkol';
      body = (rec.zadalName || 'Někdo') + ' ti zadal: ' + (rec.title || '');
      recipientUids = (rec.prirazeno || []).map(p => p.uid).filter(Boolean);
    } else if(rec.typ === 'hotovo') {
      title = '🎉 Úkol hotov';
      body = 'Úkol "' + (rec.title || '') + '" byl označen jako hotový.';
      if(rec.zadalUid) recipientUids.push(rec.zadalUid);
    } else if(rec.typ === 'komentar') {
      title = '💬 Nový komentář';
      body = rec.mentionText
        ? ((rec.mentionBy ? (rec.mentionBy + ': ') : '') + rec.mentionText)
        : ('Komentář k úkolu "' + (rec.title || '') + '"');
      if(rec.zadalUid) recipientUids.push(rec.zadalUid);
      (rec.prirazeno || []).forEach(p => { if(p.uid) recipientUids.push(p.uid); });
      if(Array.isArray(rec.mentions)) rec.mentions.forEach(uid => { if(uid) recipientUids.push(uid); });
    } else if(rec.typ === 'foto_komentar') {
      title = '💬 Komentář k fotce';
      body = (rec.zadalName || 'Někdo') + ': ' + (rec.komentText || '') + (rec.label ? (' (' + rec.label + ')') : '');
      recipientUids = (rec.recipientUids || []).filter(Boolean);
    }

    const priorita = rec.priorita || 'normalni';
    if(rec.typ === 'novy' && priorita === 'nizka') {
      console.log('Nízká priorita – push se neposílá, jen v aplikaci.');
      return snap.ref.remove();
    }

    if(rec.typ === 'chat') {
      title = '💬 ' + (rec.kanalNazev || 'Chat');
      body = (rec.zadalName || 'Někdo') + ': ' + (rec.komentText || '');
      recipientUids = (rec.recipientUids || []).filter(Boolean);
    }

    if(rec.typ === 'zminka') {
      title = '💬 Označení' + (rec.label ? (' – ' + rec.label) : '');
      body = (rec.zadalName || 'Někdo') + ': ' + (rec.komentText || '');
      recipientUids = (rec.recipientUids || []).filter(Boolean);
    }

    recipientUids = [...new Set(recipientUids)];

    if(recipientUids.length === 0) {
      console.log('Žádní příjemci, mažu záznam.');
      return snap.ref.remove();
    }

    const usersSnap = await db.ref('/uzivatele').once('value');
    const users = usersSnap.val() || {};
    if(rec.typ === 'chat' && rec.kanalId){ recipientUids = recipientUids.filter(uid => !(users[uid] && users[uid].chatMute && users[uid].chatMute[rec.kanalId] === true)); }
    const rawTokens = [];
    recipientUids.forEach(uid => {
      const u = users[uid];
      if(!u) return;
      if(u.fcmToken) rawTokens.push(u.fcmToken);
      if(u.fcmTokens) Object.keys(u.fcmTokens).forEach(k => { if(u.fcmTokens[k]) rawTokens.push(u.fcmTokens[k]); });
    });
    const tokens = [...new Set(rawTokens)];

    if(tokens.length === 0) {
      console.log('Žádné FCM tokeny u příjemců.');
      return snap.ref.remove();
    }

    const isHigh = priorita === 'vysoka';
    const message = {
      notification: { title, body },
      data: {
        taskId:   rec.taskId  || '',
        kanalId:  rec.kanalId || '',
        fotoKey:  rec.fotoKey || '',
        typ:      rec.typ     || '',
        priorita: priorita
      },
      android: {
        priority: isHigh ? 'high' : 'normal',
        notification: { priority: isHigh ? 'max' : 'default', defaultSound: true }
      },
      apns: {
        headers: { 'apns-priority': isHigh ? '10' : '5' },
        payload: { aps: { sound: 'default', 'interruption-level': isHigh ? 'time-sensitive' : 'active' } }
      },
      webpush: {
        headers: { Urgency: isHigh ? 'high' : 'normal' },
        notification: { requireInteraction: isHigh }
      },
      tokens: tokens
    };

    try {
      const resp = await admin.messaging().sendEachForMulticast(message);
      console.log('FCM odesláno:', resp.successCount, '/', tokens.length);
      const cleanupPromises = [];
      resp.responses.forEach((r, idx) => {
        if(!r.success) {
          const err = r.error;
          const badToken = tokens[idx];
          if(err && (err.code === 'messaging/invalid-registration-token' ||
                     err.code === 'messaging/registration-token-not-registered')) {
            Object.keys(users).forEach(uid => {
              const u = users[uid]; if(!u) return;
              if(u.fcmToken === badToken) cleanupPromises.push(db.ref('/uzivatele/' + uid + '/fcmToken').remove());
              if(u.fcmTokens) Object.keys(u.fcmTokens).forEach(k => { if(u.fcmTokens[k] === badToken) cleanupPromises.push(db.ref('/uzivatele/' + uid + '/fcmTokens/' + k).remove()); });
            });
          }
        }
      });
      await Promise.all(cleanupPromises);
    } catch(e) {
      console.error('Chyba odeslání FCM:', e);
    }

    return snap.ref.remove();
  });


/* ════════════════════════════════════════════════════════════════
   NOVÝ UŽIVATEL ČEKÁ NA SCHVÁLENÍ → push všem adminům (2026-11-19)
   Klient při 1. přihlášení zapíše /uzivatele/{uid} (approved chybí) → onCreate.
   Admin = role 'admin' v /uzivatele NEBO UID v ADMIN_UIDS_CF (stejné jako ADMIN_UIDS v index.html).
   Klik na oznámení otevře Správu uživatelů (#schvaleni).
   ════════════════════════════════════════════════════════════════ */
const ADMIN_UIDS_CF = [ 'PNu1CsaP2cUwmB9NNjUE8ILg89f2' ];   // ← při nové stavbě doplň UID koordinátora (jako ADMIN_UIDS v index.html)
exports.notifyNewUser = functions
  .region('europe-west1')
  .database
  .ref('/uzivatele/{uid}')
  .onCreate(async (snap, context) => {
    const u = snap.val() || {};
    const newUid = context.params.uid;
    if(u.approved === true || u.role === 'admin' || ADMIN_UIDS_CF.indexOf(newUid) !== -1) return null;
    const usersSnap = await db.ref('/uzivatele').once('value');
    const users = usersSnap.val() || {};
    const rawTokens = [];
    Object.keys(users).forEach(uid => {
      const a = users[uid];
      if(!a || uid === newUid || a.blocked === true) return;
      if(a.role !== 'admin' && ADMIN_UIDS_CF.indexOf(uid) === -1) return;
      if(a.fcmToken) rawTokens.push(a.fcmToken);
      if(a.fcmTokens) Object.keys(a.fcmTokens).forEach(k => { if(a.fcmTokens[k]) rawTokens.push(a.fcmTokens[k]); });
    });
    const tokens = [...new Set(rawTokens)];
    if(!tokens.length){ console.log('notifyNewUser: žádný admin s tokenem'); return null; }
    const kdo = u.name || u.email || u.phone || 'Nový uživatel';
    const kontakt = [u.email, u.phone].filter(Boolean).join(' · ');
    const message = {
      notification: { title: '👤 Nový uživatel čeká na schválení', body: kdo + (kontakt && kontakt !== kdo ? (' (' + kontakt + ')') : '') + ' – schval ho ve Správě uživatelů (Slapy – Tábor).' },
      data: { typ: 'schvaleni', uid: newUid },
      tokens: tokens
    };
    try {
      const resp = await admin.messaging().sendEachForMulticast(message);
      console.log('notifyNewUser FCM:', resp.successCount, '/', tokens.length);
    } catch(e) { console.error('notifyNewUser chyba:', e); }
    return null;
  });
