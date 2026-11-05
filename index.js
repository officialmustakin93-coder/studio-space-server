import express from "express";
import cors from "cors";
import { ObjectId } from 'mongodb';
import 'dotenv/config'
import { toNodeHandler } from "better-auth/node";
import { mongoClient, db, ensureConnected } from "./db.js";
import { auth } from "./auth.js";

const PORT = process.env.PORT || 5000;

await ensureConnected();
console.log("You successfully connected to MongoDB!");

const app = express();

// CORS first so browser preflight (OPTIONS) is answered before BetterAuth reads the request
app.use(cors({
  origin: ["http://localhost:3000", "http://localhost:3001", "http://localhost:3002"],
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// BetterAuth routes next (handles its own body parsing / cookie handling)
app.all("/api/auth/*splat", toNodeHandler(auth));

app.use(express.json());

const studiosCollection = db.collection("studios");
const bookingsCollection = db.collection("bookings");
const reviewsCollection = db.collection("reviews");
await reviewsCollection.createIndex({ studioId: 1, reviewerId: 1 }, { unique: true });

function deny(res, code, message) {
  res.status(code).json({ message });
}

async function getSessionUser(req) {
  try {
    const result = await auth.api.getSession({ headers: req.headers });
    return result?.user ?? null;
  } catch {
    return null;
  }
}

// ================= STUDIOS ROUTES =================

app.post("/studios", async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return deny(res, 401, "You must be signed in to add a studio.");
  const studioData = { ...req.body, ownerId: user.id };
  const result = await studiosCollection.insertOne(studioData);
  res.send(result);
});

app.get("/studios", async (req, res) => {
  const raw =
    typeof req.query.name === "string"
      ? req.query.name
      : typeof req.query.q === "string"
        ? req.query.q
        : "";
  const search = raw.trim();
  // Case-insensitive partial match on the studio title; special regex
  // characters escaped so user input is treated literally.
  const query = search
    ? {
        $or: [
          { title: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
          { name: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
        ],
      }
    : {};
  const result = await studiosCollection.find(query).toArray();
  res.send(result);
});

app.get("/studios/mine", async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return deny(res, 401, "Sign in required to view your listings.");
  const result = await studiosCollection
    .find({ ownerId: user.id })
    .toArray();
  res.send(result);
});

app.get("/studios/:id", async (req, res) => {
  const id = req.params.id;
  let query;
  try {
    query = { _id: new ObjectId(id) };
  } catch {
    return deny(res, 400, "Invalid studio id.");
  }
  const result = await studiosCollection.findOne(query);
  res.send(result);
});

app.patch("/studios/:id", async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return deny(res, 401, "Sign in required to edit a studio.");

  const id = req.params.id;
  let query;
  try {
    query = { _id: new ObjectId(id) };
  } catch {
    return deny(res, 400, "Invalid studio id.");
  }

  const studio = await studiosCollection.findOne(query);
  if (!studio) return deny(res, 404, "Studio not found.");
  // Ownership rule: legacy ownerless studios are locked for everyone;
  // owned studios may only be edited by their owner.
  if (studio.ownerId !== user.id) return deny(res, 403, "Only the studio owner can edit this studio.");

  const updatedData = req.body;
  const updateDoc = { $set: updatedData };
  const result = await studiosCollection.updateOne(query, updateDoc);
  res.send(result);
});

app.delete("/studios/:id", async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return deny(res, 401, "Sign in required to delete a studio.");

  const id = req.params.id;
  let query;
  try {
    query = { _id: new ObjectId(id) };
  } catch {
    return deny(res, 400, "Invalid studio id.");
  }

  const studio = await studiosCollection.findOne(query);
  if (!studio) return deny(res, 404, "Studio not found.");
  if (studio.ownerId !== user.id) return deny(res, 403, "Only the studio owner can delete this studio.");

  const result = await studiosCollection.deleteOne(query);
  res.send(result);
});

app.get("/studios/:id/reviews", async (req, res) => {
  const id = req.params.id;
  if (!/^[a-fA-F0-9]{24}$/.test(id)) return deny(res, 400, "Invalid studio id.");

  const studioId = new ObjectId(id).toHexString();
  const studio = await studiosCollection.findOne({ _id: new ObjectId(studioId) });
  if (!studio) return deny(res, 404, "Studio not found.");

  const result = await reviewsCollection
    .find({ studioId })
    .sort({ createdAt: -1 })
    .toArray();
  res.send(result);
});

app.post("/studios/:id/reviews", async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return deny(res, 401, "You must be signed in to leave a review.");

  const id = req.params.id;
  if (!/^[a-fA-F0-9]{24}$/.test(id)) return deny(res, 400, "Invalid studio id.");

  const studioId = new ObjectId(id).toHexString();
  const studio = await studiosCollection.findOne({ _id: new ObjectId(studioId) });
  if (!studio) return deny(res, 404, "Studio not found.");

  const { rating, comment } = req.body ?? {};
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return deny(res, 400, "Invalid rating. Expected an integer between 1 and 5.");
  }
  if (typeof comment !== "string" || !comment.trim()) {
    return deny(res, 400, "A comment is required.");
  }

  try {
    const result = await reviewsCollection.insertOne({
      studioId,
      reviewerId: user.id,
      rating,
      comment: comment.trim(),
      createdAt: new Date(),
    });
    res.send(result);
  } catch (err) {
    if (err.code === 11000) return deny(res, 409, "You have already reviewed this studio.");
    console.error("Review save failed:", err.message);
    return deny(res, 500, "Review could not be saved.");
  }
});

// ================= BOOKINGS ROUTES =================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function toMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function isValidDate(date) {
  if (!DATE_RE.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

app.post("/bookings", async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return deny(res, 401, "You must be signed in to make a booking.");

  const { studioId, date, time, hours } = req.body ?? {};

  // --- Input validation ---
  if (typeof studioId !== "string" || !/^[a-fA-F0-9]{24}$/.test(studioId)) {
    return deny(res, 400, "Invalid studio id.");
  }
  if (typeof date !== "string" || !isValidDate(date)) {
    return deny(res, 400, "Invalid date. Expected YYYY-MM-DD.");
  }
  if (typeof time !== "string" || !TIME_RE.test(time)) {
    return deny(res, 400, "Invalid time. Expected HH:mm.");
  }
  const dayHours = Number(hours);
  if (!Number.isInteger(dayHours) || dayHours < 1 || dayHours > 12) {
    return deny(res, 400, "Invalid hours. Expected an integer between 1 and 12.");
  }

  const start = toMinutes(time);
  const end = start + dayHours * 60;

  // --- Race-safe booking: find conflicting slots + insert inside one transaction ---
  // (no check-then-insert fallback: if transactions are unsupported we fail loudly)
  let newId;
  try {
    const session = mongoClient.startSession();
    try {
      await session.withTransaction(async () => {
        const existing = await bookingsCollection
          .find(
            { studioId, date: date },
            { projection: { time: 1, hours: 1 } },
            { session }
          )
          .toArray();

        for (const old of existing) {
          if (!TIME_RE.test(String(old.time))) continue; // skip malformed legacy rows
          const oldHours = Number(old.hours);
          if (!Number.isInteger(oldHours) || oldHours < 1) continue;
          const oStart = toMinutes(String(old.time));
          const oEnd = oStart + oldHours * 60;
          if (start < oEnd && oStart < end) {
            const err = new Error("CONFLICT");
            err.isConflict = true;
            throw err;
          }
        }

        const result = await bookingsCollection.insertOne(
          { ...req.body, ownerEmail: user.email },
          { session }
        );
        newId = result.insertedId;
      });
    } finally {
      await session.endSession();
    }
  } catch (err) {
    if (err.isConflict) {
      return deny(res, 409, "Studio already booked for this time slot.");
    }
    console.error("Booking transaction failed:", err.message);
    return deny(res, 500, "Booking could not be saved transactionally. Please retry.");
  }

  res.send({ insertedId: newId });
});

app.get("/bookings", async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return deny(res, 401, "Sign in required to view bookings.");
  // Users may only see their own bookings. Legacy bookings (pre-auth, no
  // ownerEmail) fall back to matching their contact email field.
  const query = {
    $or: [
      { ownerEmail: user.email },
      { ownerEmail: { $exists: false }, email: user.email },
    ],
  };
  const result = await bookingsCollection.find(query).toArray();
  res.send(result);
});

app.delete("/bookings/:id", async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return deny(res, 401, "Sign in required to cancel a booking.");

  const id = req.params.id;
  let query;
  try {
    query = { _id: new ObjectId(id) };
  } catch {
    return deny(res, 400, "Invalid booking id.");
  }

  const booking = await bookingsCollection.findOne(query);
  if (!booking) return deny(res, 404, "Booking not found.");
  const owns =
    booking.ownerEmail === user.email ||
    (booking.ownerEmail === undefined && booking.email === user.email);
  if (!owns) return deny(res, 403, "Only the booking owner can cancel this booking.");

  const result = await bookingsCollection.deleteOne(query);
  res.send(result);
});

// end step
app.get("/", (req, res) => {
  res.send("Hello PH!");
});

const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    mongoClient.close().finally(() => process.exit(0));
  });
}
