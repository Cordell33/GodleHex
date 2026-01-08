const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.firestore();
const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,15}$/;
const RENAME_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

exports.renameUsername = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'You must be signed in to rename.');
  }

  const rawUsername = typeof data?.newUsername === 'string' ? data.newUsername.trim() : '';
  if (!USERNAME_REGEX.test(rawUsername)) {
    throw new functions.https.HttpsError('invalid-argument', 'Username must be 3–15 characters (letters, numbers, underscore).');
  }

  const newLower = rawUsername.toLowerCase();
  const userRef = db.collection('users').doc(uid);
  const newUsernameRef = db.collection('usernames').doc(newLower);

  return db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    const userData = userSnap.exists ? userSnap.data() : {};
    const currentLower = userData?.usernameLower || null;

    if (currentLower && currentLower === newLower) {
      return { username: userData.username || rawUsername };
    }

    if (userData?.lastUsernameChangeAt && RENAME_COOLDOWN_MS > 0) {
      const lastChange = userData.lastUsernameChangeAt.toMillis();
      const elapsed = Date.now() - lastChange;
      if (elapsed < RENAME_COOLDOWN_MS) {
        const remainingMs = RENAME_COOLDOWN_MS - elapsed;
        const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
        throw new functions.https.HttpsError(
          'failed-precondition',
          `You can change your username again in ${remainingDays} day(s).`
        );
      }
    }

    const newUsernameSnap = await tx.get(newUsernameRef);
    if (newUsernameSnap.exists) {
      const owner = newUsernameSnap.data()?.uid;
      if (owner !== uid) {
        throw new functions.https.HttpsError('already-exists', 'That username is already taken.');
      }
    }

    tx.set(newUsernameRef, {
      uid,
      username: rawUsername,
      claimedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    tx.set(userRef, {
      username: rawUsername,
      usernameLower: newLower,
      lastUsernameChangeAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    if (currentLower && currentLower !== newLower) {
      const oldUsernameRef = db.collection('usernames').doc(currentLower);
      tx.delete(oldUsernameRef);
    }

    return { username: rawUsername };
  });
});
