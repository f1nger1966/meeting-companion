/**
 * sessionStore.js — Firestore-backed express-session store
 *
 * Built directly on firebase-admin so there are no version-mismatch issues
 * between @google-cloud/connect-firestore and firebase-admin's internal
 * @google-cloud/firestore copy.
 */
'use strict';

const { Store } = require('express-session');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

class FirestoreSessionStore extends Store {
  /**
   * @param {FirebaseFirestore.Firestore} db   – admin.firestore() instance
   * @param {string} [collection='sessions']  – Firestore collection name
   */
  constructor(db, collection = 'sessions') {
    super();
    this.db = db;
    this.col = collection;
  }

  /** Return session data or null (called on every request) */
  get(sid, callback) {
    console.log('[SESSION] get →', sid);
    this.db.collection(this.col).doc(sid).get()
      .then(doc => {
        if (!doc.exists) {
          console.log('[SESSION] get → NOT FOUND in Firestore:', sid);
          return callback(null, null);
        }
        const { sess, expires } = doc.data();
        if (expires && Date.now() > expires) {
          console.log('[SESSION] get → EXPIRED:', sid);
          this.destroy(sid, () => {});
          return callback(null, null);
        }
        console.log('[SESSION] get → FOUND, userEmail:', sess?.userEmail);
        callback(null, sess);
      })
      .catch(err => {
        console.error('[SESSION] get error:', err.message);
        callback(err);
      });
  }

  /** Persist session data (called after session is modified) */
  set(sid, sess, callback) {
    const expires = sess.cookie?.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + SESSION_TTL_MS;

    // Strip the Session prototype — Firestore rejects objects created with `new`
    const plainSess = JSON.parse(JSON.stringify(sess));

    this.db.collection(this.col).doc(sid).set({ sess: plainSess, expires, updatedAt: Date.now() })
      .then(() => callback(null))
      .catch(err => {
        console.error('[SESSION] set error:', err.message);
        callback(err);
      });
  }

  /** Delete a session */
  destroy(sid, callback) {
    this.db.collection(this.col).doc(sid).delete()
      .then(() => callback(null))
      .catch(err => {
        console.error('[SESSION] destroy error:', err.message);
        callback(err);
      });
  }

  /** Refresh TTL without changing session data */
  touch(sid, sess, callback) {
    this.set(sid, sess, callback);
  }
}

module.exports = { FirestoreSessionStore };
