import { MongoClient } from "mongodb";
import "dotenv/config";

export const mongoClient = new MongoClient(process.env.MONGO_URI);

export const db = mongoClient.db("studio-space");

export async function ensureConnected() {
  await mongoClient.connect();
}
