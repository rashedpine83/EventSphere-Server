import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose-cjs";
import { Request, Response, NextFunction } from "express";
dotenv.config();
const port = process.env.PORT || 8000;

const app = express();
app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("MONGODB_URI is missing");
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL}/api/auth/jwks`),
);

interface AuthRequest extends Request {
  user?: {
    id?: string;
    name: string;
    email: string;
  };
}

const verifyToken = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const { payload } = await jwtVerify(token, JWKS);

    req.user = {
      id: payload.sub as string,
      name: payload.name as string,
      email: payload.email as string,
    };

    next();
  } catch (error) {
    return res.status(403).json({
      success: false,
      message: "Invalid Token",
    });
  }
};

async function run() {
  try {
    await client.connect();
    const database = client.db("EventSphere");
    const eventsCollection = database.collection("events");
    const usersCollection = database.collection("user");

    app.post(
      "/api/events",
      verifyToken,
      async (req: AuthRequest, res: Response) => {
        try {
          const {
            title,
            description,
            category,
            location,
            eventDate,
            startTime,
            endTime,
            attendeeLimit,
            image,
          } = req.body;

          // Validation
          if (
            !title ||
            !description ||
            !category ||
            !location ||
            !eventDate ||
            !image
          ) {
            return res.status(400).json({
              success: false,
              message: "All required fields are required.",
            });
          }

          if (!req.user) {
            return res.status(401).json({
              success: false,
              message: "Unauthorized",
            });
          }

          const event = {
            title,
            description,
            category,
            location,
            eventDate,
            startTime,
            endTime,
            attendeeLimit: Number(attendeeLimit) || 0,
            image,

            organizerName: req.user.name,
            organizerEmail: req.user.email,

            createdAt: new Date(),
          };

          const result = await eventsCollection.insertOne(event);

          return res.status(201).json({
            success: true,
            message: "Event created successfully.",
            insertedId: result.insertedId,
          });
        } catch (error) {
          console.error("Create Event Error:", error);

          return res.status(500).json({
            success: false,
            message: "Internal Server Error",
          });
        }
      },
    );

    app.get("/api/events", async (req: Request, res: Response) => {
      const events = await eventsCollection
        .find()
        .sort({ createdAt: -1 })
        .toArray();
      res.status(200).json({
        success: true,
        events,
      });
    });

    app.get(
      "/api/my-events",
      verifyToken,
      async (req: AuthRequest, res: Response) => {
        try {
          const events = await eventsCollection
            .find({
              organizerEmail: req.user.email,
            })
            .sort({ createdAt: -1 })
            .toArray();

          res.status(200).json({
            success: true,
            events,
          });
        } catch (error) {
          console.error(error);

          res.status(500).json({
            success: false,
            message: "Internal Server Error",
          });
        }
      },
    );

    app.get(
      "/api/events/:id",
      async (req: Request<{ id: string }>, res: Response) => {
        try {
          const { id } = req.params;

          if (!ObjectId.isValid(id)) {
            return res.status(400).json({
              success: false,
              message: "Invalid Event ID",
            });
          }

          const event = await eventsCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!event) {
            return res.status(404).json({
              success: false,
              message: "Event not found",
            });
          }

          res.status(200).json({
            success: true,
            event,
          });
        } catch (error) {
          console.error(error);

          res.status(500).json({
            success: false,
            message: "Internal Server Error",
          });
        }
      },
    );

    app.patch(
      "/api/events/:id",
      verifyToken,
      async (req: AuthRequest, res: Response) => {
        try {
          const { id } = req.params;

          if (!ObjectId.isValid(id)) {
            return res.status(400).json({
              success: false,
              message: "Invalid Event ID",
            });
          }

          const existingEvent = await eventsCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!existingEvent) {
            return res.status(404).json({
              success: false,
              message: "Event not found",
            });
          }

          // Only organizer can update
          if (existingEvent.organizerEmail !== req.user.email) {
            return res.status(403).json({
              success: false,
              message: "You are not authorized to update this event.",
            });
          }

          const {
            title,
            description,
            category,
            location,
            eventDate,
            startTime,
            endTime,
            attendeeLimit,
            image,
          } = req.body;

          const result = await eventsCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                title,
                description,
                category,
                location,
                eventDate,
                startTime,
                endTime,
                attendeeLimit,
                image,
              },
            },
          );

          res.status(200).json({
            success: true,
            message: "Event updated successfully.",
            result,
          });
        } catch (error) {
          console.error(error);

          res.status(500).json({
            success: false,
            message: "Internal Server Error",
          });
        }
      },
    );
    app.delete(
      "/api/events/:id",
      verifyToken,
      async (req: AuthRequest, res: Response) => {
        try {
          const { id } = req.params;

          if (!ObjectId.isValid(id)) {
            return res.status(400).json({
              success: false,
              message: "Invalid Event ID",
            });
          }

          const existingEvent = await eventsCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!existingEvent) {
            return res.status(404).json({
              success: false,
              message: "Event not found",
            });
          }

          // Only organizer can delete
          if (existingEvent.organizerEmail !== req.user.email) {
            return res.status(403).json({
              success: false,
              message: "You are not authorized to delete this event.",
            });
          }

          const result = await eventsCollection.deleteOne({
            _id: new ObjectId(id),
          });

          res.status(200).json({
            success: true,
            message: "Event deleted successfully.",
            result,
          });
        } catch (error) {
          console.error(error);

          res.status(500).json({
            success: false,
            message: "Internal Server Error",
          });
        }
      },
    );

    app.post("/api/users", async (req: Request, res: Response) => {
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.get("/api/users", async (req: Request, res: Response) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
