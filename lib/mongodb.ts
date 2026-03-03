import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;

if (!uri || uri === "") {
  throw new Error("MONGODB_URI is not configured. Add it to .env.local");
}

declare global {
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

let clientPromise: Promise<MongoClient>;

if (global._mongoClientPromise) {
  clientPromise = global._mongoClientPromise;
} else {
  const client = new MongoClient(uri);
  clientPromise = client.connect();
  global._mongoClientPromise = clientPromise;
}

export async function getDb() {
  const client = await clientPromise;
  // Use the database specified in the URI; if none, MongoDB will use "test"
  return client.db();
}

