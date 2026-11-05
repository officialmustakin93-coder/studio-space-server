import express from "express";
import cors from "cors";
import { ObjectId } from "mongodb";
import "dotenv/config";
import { toNodeHandler } from "better-auth/node";
import { mongoClient, db, ensureConnected } from "./db.js";
import { auth } from "./auth.js";

const PORT = process.env.PORT || 5000;

await ensureConnected();
console.log("You successfully connected to MongoDB!");

const app = express();

// ================= CORS =================

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:3002",
      "http://127.0.0.1:3000",
      "https://studio-space-client-kappa.vercel.app",
    ],
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ================= BETTER AUTH =================

app.all("/api/auth/*splat", toNodeHandler(auth));

app.use(express.json());

// ================= COLLECTIONS =================

const studiosCollection = db.collection("studios");
const bookingsCollection = db.collection("bookings");
const reviewsCollection = db.collection("reviews");

await reviewsCollection.createIndex(
  { studioId: 1, reviewerId: 1 },
  { unique: true }
);

// ================= HELPER FUNCTIONS =================

function deny(res, code, message) {
  res.status(code).json({ message });
}

async function getSessionUser(req) {
  try {
    const result = await auth.api.getSession({
      headers: req.headers,
    });

    return result?.user ?? null;
  } catch {
    return null;
  }
}

// ================= STUDIOS ROUTES =================

// Add studio
app.post("/studios", async (req, res) => {
  const user = await getSessionUser(req);

  if (!user) {
    return deny(res, 401, "You must be signed in to add a studio.");
  }

  const studioData = {
    ...req.body,
    ownerId: user.id,
  };

  const result = await studiosCollection.insertOne(studioData);
  res.send(result);
});

// Get all studios
app.get("/studios", async (req, res) => {
  const raw =
    typeof req.query.name === "string"
      ? req.query.name
      : typeof req.query.q === "string"
        ? req.query.q
        : "";

  const search = raw.trim();

  const escapedSearch = search.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

  const query = search
    ? {
        $or: [
          { title: { $regex: escapedSearch, $options: "i" } },
          { name: { $regex: escapedSearch, $options: "i" } },
        ],
      }
    : {};

  const result = await studiosCollection.find(query).toArray();
  res.send(result);
});

// Get my studios
app.get("/studios/mine", async (req, res) => {
  const user = await getSessionUser(req);

  if (!user) {
    return deny(res, 401, "Sign in required to view your listings.");
  }

  const result = await studiosCollection
    .find({ ownerId: user.id })
    .toArray();

  res.send(result);
});

// Get single studio
app.get("/studios/:id", async (req, res) => {
  let query;

  try {
    query = { _id: new ObjectId(req.params.id) };
  } catch {
    return deny(res, 400, "Invalid studio id.");
  }

  const result = await studiosCollection.findOne(query);
  res.send(result);
});

// Update studio
app.patch("/studios/:id", async (req, res) => {
  const user = await getSessionUser(req);

  if (!user) {
    return deny(res, 401, "Sign in required to edit a studio.");
  }

  let query;

  try {
    query = { _id: new ObjectId(req.params.id) };
  } catch {
    return deny(res, 400, "Invalid studio id.");
  }

  const studio = await studiosCollection.findOne(query);

  if (!studio) {
    return deny(res, 404, "Studio not found.");
  }

  if (studio.ownerId !== user.id) {
    return deny(res, 403, "Only the studio owner can edit this studio.");
  }

  const result = await studiosCollection.updateOne(query, {
    $set: req.body,
  });

  res.send(result);
});

// Delete studio
app.delete("/studios/:id", async (req, res) => {
  const user = await getSessionUser(req);

  if (!user) {
    return deny(res, 401, "Sign in required to delete a studio.");
  }

  let query;

  try {
    query = { _id: new ObjectId(req.params.id) };
  } catch {
    return deny(res, 400, "Invalid studio id.");
  }

  const studio = await studiosCollection.findOne(query);

  if (!studio) {
    return deny(res, 404, "Studio not found.");
  }

  if (studio.ownerId !== user.id) {
    return deny(res, 403, "Only the studio owner can delete this studio.");
  }

  const result = await studiosCollection.deleteOne(query);
  res.send(result);
});

// ================= REVIEWS ROUTES =================

// Get reviews
app.get("/studios/:id/reviews", async (req, res) => {
  const id = req.params.id;

  if (!/^[a-fA-F0-9]{24}$/.test(id)) {
    return deny(res, 400, "Invalid studio id.");
  }

  const studioId = new ObjectId(id).toHexString();

  const studio = await studiosCollection.findOne({
    _id: new ObjectId(studioId),
  });

  if (!studio) {
    return deny(res, 404, "Studio not found.");
  }

  const result = await reviewsCollection
    .find({ studioId })
    .sort({ createdAt: -1 })
    .toArray();

  res.send(result);
});

// Add review
app.post("/studios/:id/reviews", async (req, res) => {
  const user = await getSessionUser(req);

  if (!user) {
    return deny(res, 401, "You must be signed in to leave a review.");
  }

  const id = req.params.id;

  if (!/^[a-fA-F0-9]{24}$/.test(id)) {
    return deny(res, 400, "Invalid studio id.");
  }

  const studioId = new ObjectId(id).toHexString();

  const studio = await studiosCollection.findOne({
    _id: new ObjectId(studioId),
  });

  if (!studio) {
    return deny(res, 404, "Studio not found.");
  }

  const { rating, comment } = req.body ?? {};

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return deny(
      res,
      400,
      "Invalid rating. Expected an integer between 1 and 5."
    );
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
    if (err.code === 11000) {
      return deny(res, 409, "You have already reviewed this studio.");
    }

    console.error("Review save failed:", err.message);
    return deny(res, 500, "Review could not be saved.");
  }
});

// ================= BOOKINGS ROUTES =================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function toMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function isValidDate(date) {
  if (!DATE_RE.test(date)) return false;

  const [year, month, day] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));

  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

// Create booking
app.post("/bookings", async (req, res) => {
  const user = await getSessionUser(req);

  if (!user) {
    return deny(res, 401, "You must be signed in to make a booking.");
  }

  const { studioId, date, time, hours } = req.body ?? {};

  if (
    typeof studioId !== "string" ||
    !/^[a-fA-F0-9]{24}$/.test(studioId)
  ) {
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

  let newId;

  try {
    const session = mongoClient.startSession();

    try {
      await session.withTransaction(async () => {
        const existing = await bookingsCollection
          .find(
            { studioId, date },
            {
              projection: { time: 1, hours: 1 },
              session,
            }
          )
          .toArray();

        for (const old of existing) {
          if (!TIME_RE.test(String(old.time))) continue;

          const oldHours = Number(old.hours);

          if (!Number.isInteger(oldHours) || oldHours < 1) continue;

          const oldStart = toMinutes(String(old.time));
          const oldEnd = oldStart + oldHours * 60;

          if (start < oldEnd && oldStart < end) {
            const error = new Error("CONFLICT");
            error.isConflict = true;
            throw error;
          }
        }

        const result = await bookingsCollection.insertOne(
          {
            ...req.body,
            ownerEmail: user.email,
          },
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

    return deny(
      res,
      500,
      "Booking could not be saved transactionally. Please retry."
    );
  }

  res.send({ insertedId: newId });
});

// Get my bookings
app.get("/bookings", async (req, res) => {
  const user = await getSessionUser(req);

  if (!user) {
    return deny(res, 401, "Sign in required to view bookings.");
  }

  const query = {
    $or: [
      { ownerEmail: user.email },
      {
        ownerEmail: { $exists: false },
        email: user.email,
      },
    ],
  };

  const result = await bookingsCollection.find(query).toArray();
  res.send(result);
});

// Cancel booking
app.delete("/bookings/:id", async (req, res) => {
  const user = await getSessionUser(req);

  if (!user) {
    return deny(res, 401, "Sign in required to cancel a booking.");
  }

  let query;

  try {
    query = { _id: new ObjectId(req.params.id) };
  } catch {
    return deny(res, 400, "Invalid booking id.");
  }

  const booking = await bookingsCollection.findOne(query);

  if (!booking) {
    return deny(res, 404, "Booking not found.");
  }

  const owns =
    booking.ownerEmail === user.email ||
    (booking.ownerEmail === undefined && booking.email === user.email);

  if (!owns) {
    return deny(res, 403, "Only the booking owner can cancel this booking.");
  }

  const result = await bookingsCollection.deleteOne(query);
  res.send(result);
});

// ================= HOME ROUTE =================

app.get("/", (req, res) => {
  res.send("Hello PH!");
});

// ================= START SERVER =================

const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// ================= GRACEFUL SHUTDOWN =================

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();

    mongoClient.close().finally(() => {
      process.exit(0);
    });
  });
}