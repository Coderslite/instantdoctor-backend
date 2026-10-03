import { getAuth, type UserRecord } from 'firebase-admin/auth';
import { getFirestore, type DocumentData } from 'firebase-admin/firestore';
import { getFirebaseApp } from '../../src/integrations/firebase.js';

export interface SourceDoc {
  id: string;
  /** Parent document id for subcollection documents. */
  parentId?: string;
  data: DocumentData;
}

function firestore() {
  const app = getFirebaseApp();
  if (!app) throw new Error('FIREBASE_SERVICE_ACCOUNT_PATH must point to the legacy project service account');
  return getFirestore(app);
}

export async function readCollection(name: string): Promise<SourceDoc[]> {
  const snap = await firestore().collection(name).get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

/** All documents of a subcollection under a given root collection. */
export async function readSubcollection(root: string, sub: string): Promise<SourceDoc[]> {
  const snap = await firestore().collectionGroup(sub).get();
  return snap.docs
    .filter((d) => d.ref.parent.parent?.parent.id === root)
    .map((d) => ({ id: d.id, parentId: d.ref.parent.parent!.id, data: d.data() }));
}

export async function readAuthUsers(): Promise<UserRecord[]> {
  const app = getFirebaseApp();
  if (!app) return [];
  const all: UserRecord[] = [];
  let pageToken: string | undefined;
  do {
    const page = await getAuth(app).listUsers(1000, pageToken);
    all.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);
  return all;
}
