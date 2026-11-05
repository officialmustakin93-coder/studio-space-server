import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { db, mongoClient } from "./db.js";

const googleEnabled =
  Boolean(process.env.GOOGLE_CLIENT_ID) && Boolean(process.env.GOOGLE_CLIENT_SECRET);

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  basePath: "/api/auth",
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:5000",
  database: mongodbAdapter(db, { client: mongoClient }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  trustedOrigins: ["http://localhost:3000", "http://localhost:3001", "http://localhost:3002"],
  ...(googleEnabled
    ? {
        socialProviders: {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          },
        },
      }
    : {}),
});
