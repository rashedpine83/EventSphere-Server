import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose-cjs";
import { Request, Response, NextFunction } from "express";
import Stripe from "stripe";
dotenv.config();
const port = process.env.PORT || 8000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

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
    const registrationsCollection = database.collection("registrations");
    const usersCollection = database.collection("user");

    app.post(
      "/api/payment/create-checkout-session",
      verifyToken,
      async (req: AuthRequest, res: Response) => {
        try {
          const { registrationId } = req.body;

          if (!ObjectId.isValid(registrationId)) {
            return res.status(400).json({
              success: false,
              message: "Invalid Registration ID",
            });
          }

          const registration = await registrationsCollection.findOne({
            _id: new ObjectId(registrationId),
          });

          if (!registration) {
            return res.status(404).json({
              success: false,
              message: "Registration not found.",
            });
          }

          if (registration.attendeeEmail !== req.user?.email) {
            return res.status(403).json({
              success: false,
              message: "Unauthorized.",
            });
          }

          if (registration.paymentStatus === "paid") {
            return res.status(400).json({
              success: false,
              message: "Already paid.",
            });
          }

          const session = await stripe.checkout.sessions.create({
            mode: "payment",

            payment_method_types: ["card"],

            customer_email: registration.attendeeEmail,

            line_items: [
              {
                quantity: 1,

                price_data: {
                  currency: "usd",

                  unit_amount: registration.ticketPrice * 100,

                  product_data: {
                    name: registration.eventTitle,
                    description: registration.eventCategory,
                  },
                },
              },
            ],

            metadata: {
              registrationId: registration._id.toString(),
            },

            success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,

            cancel_url: `${process.env.CLIENT_URL}/payment/cancel`,
          });

          res.status(200).json({
            success: true,
            checkoutUrl: session.url,
            message: "Checkout session created successfully.",
          });
        } catch (error) {
          console.error(error);

          res.status(500).json({
            success: false,
            message: "Stripe session creation failed.",
          });
        }
      },
    );

    app.get("/api/payment/success", async (req: Request, res: Response) => {
      try {
        const sessionId = req.query.session_id as string;

        if (!sessionId) {
          return res.status(400).json({
            success: false,
            message: "Session ID is required.",
          });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status !== "paid") {
          return res.status(400).json({
            success: false,
            message: "Payment not completed.",
          });
        }

        const registrationId = session.metadata?.registrationId;

        if (!registrationId) {
          return res.status(400).json({
            success: false,
            message: "Registration ID not found.",
          });
        }

        await registrationsCollection.updateOne(
          {
            _id: new ObjectId(registrationId),
          },
          {
            $set: {
              paymentStatus: "paid",
              transactionId: session.payment_intent?.toString(),
              paidAt: new Date(),
            },
          },
        );

        const registration = await registrationsCollection.findOne({
          _id: new ObjectId(registrationId),
        });

        res.status(200).json({
          success: true,
          registrationId,
          ticketId: registration?._id,
        });
      } catch (error) {
        console.error(error);

        res.status(500).json({
          success: false,
          message: "Payment verification failed.",
        });
      }
    });
    app.post(
      "/api/events/:id/register",
      verifyToken,
      async (req: AuthRequest, res: Response) => {
        try {
          const { id } = req.params as { id: string };

          const { attendeeName, phone, address } = req.body;

          // ================= Validation =================

          if (!ObjectId.isValid(id)) {
            return res.status(400).json({
              success: false,
              message: "Invalid Event ID",
            });
          }

          if (!attendeeName || !phone) {
            return res.status(400).json({
              success: false,
              message: "Name and phone are required.",
            });
          }

          // ================= Find Event =================

          const event = await eventsCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!event) {
            return res.status(404).json({
              success: false,
              message: "Event not found.",
            });
          }

          // ================= Organizer Check =================

          if (event.organizerEmail === req.user?.email) {
            return res.status(400).json({
              success: false,
              message: "You cannot join your own event.",
            });
          }

          // ================= Event Expired =================

          const eventEnd = new Date(`${event.eventDate}T${event.endTime}`);

          if (eventEnd < new Date()) {
            return res.status(400).json({
              success: false,
              message: "This event has already ended.",
            });
          }

          // ================= Duplicate Check =================

          const alreadyRegistered = await registrationsCollection.findOne({
            eventId: id,
            attendeeEmail: req.user?.email,
          });

          if (alreadyRegistered) {
            return res.status(400).json({
              success: false,
              message: "You have already registered for this event.",
            });
          }

          // ================= Seat Check =================

          const totalRegistration =
            await registrationsCollection.countDocuments({
              eventId: id,
            });

          if (totalRegistration >= event.attendeeLimit) {
            return res.status(400).json({
              success: false,
              message: "No seats available.",
            });
          }

          // ================= Registration =================

          const registration = {
            eventId: id,

            eventTitle: event.title,
            eventCategory: event.category,
            eventImage: event.image,

            eventDate: event.eventDate,
            startTime: event.startTime,
            endTime: event.endTime,

            location: event.location,

            organizerName: event.organizerName,
            organizerEmail: event.organizerEmail,

            attendeeName,
            attendeeEmail: req.user?.email,

            phone,
            address: address || "",

            paymentStatus: event.isPaid ? "pending" : "free",

            ticketPrice: event.ticketPrice,

            joinedAt: new Date(),
          };

          const result = await registrationsCollection.insertOne(registration);

          // ================= Remaining Seats =================

          const remainingSeats = event.attendeeLimit - (totalRegistration + 1);

          res.status(201).json({
            success: true,
            message: event.isPaid
              ? "Registration successful. Please complete payment."
              : "Registration successful.",

            insertedId: result.insertedId,

            isPaid: event.isPaid,

            remainingSeats,
          });
        } catch (error) {
          console.error("Registration Error:", error);

          res.status(500).json({
            success: false,
            message: "Internal Server Error",
          });
        }
      },
    );

    app.get("/api/registrations/:id", async (req: Request, res: Response) => {
      try {
        const { id } = req.params as { id: string };

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid Registration ID",
          });
        }

        const registration = await registrationsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!registration) {
          return res.status(404).json({
            success: false,
            message: "Ticket not found.",
          });
        }

        return res.status(200).json({
          success: true,
          ticket: registration,
        });
      } catch (error) {
        console.error(error);

        return res.status(500).json({
          success: false,
          message: "Internal Server Error",
        });
      }
    });

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

            isPaid,
            ticketPrice,
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
            attendeeLimit,
            image,
            isPaid,
            ticketPrice,

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

    // app.get("/api/events", async (req: Request, res: Response) => {
    //   const events = await eventsCollection
    //     .find()
    //     .sort({ createdAt: -1 })
    //     .toArray();
    //   res.status(200).json({
    //     success: true,
    //     events,
    //   });
    // });

    app.get("/api/events", async (req: Request, res: Response) => {
      try {
        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 12;

        const skip = (page - 1) * limit;

        const events = await eventsCollection
          .find()
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();

        const totalCount = await eventsCollection.countDocuments();
        const totalPages = Math.ceil(totalCount / limit);

        res.status(200).json({
          success: true,
          events,
          page,
          totalPages,
          totalCount,
        });
      } catch (error) {
        console.error(error);

        res.status(500).json({
          success: false,
          message: "Failed to fetch events.",
        });
      }
    });

    app.get(
      "/api/my-events",
      verifyToken,
      async (req: AuthRequest, res: Response) => {
        try {
          const events = await eventsCollection
            .find({
              organizerEmail: req.user?.email,
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
      // Optional middleware
      async (req: AuthRequest, res: Response) => {
        try {
          const { id } = req.params as { id: string };

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
              message: "Event not found.",
            });
          }

          // Total Registered Users
          const registeredCount = await registrationsCollection.countDocuments({
            eventId: id,
          });

          // Remaining Seats
          const remainingSeats = Math.max(
            0,
            event.attendeeLimit - registeredCount,
          );

          // Current User Already Registered?
          let alreadyRegistered = false;

          if (req.user?.email) {
            alreadyRegistered = !!(await registrationsCollection.findOne({
              eventId: id,
              attendeeEmail: req.user.email,
            }));
          }

          res.status(200).json({
            success: true,

            event: {
              ...event,

              registeredCount,

              remainingSeats,

              alreadyRegistered,
            },
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
          const { id } = req.params as { id: string };

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
          if (existingEvent.organizerEmail !== req.user?.email) {
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
          const { id } = req.params as { id: string };

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
          if (existingEvent.organizerEmail !== req.user?.email) {
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
      try {
        const { name, email, image, role } = req.body;

        if (!name || !email) {
          return res.status(400).json({
            success: false,
            message: "Name and email are required.",
          });
        }

        const user = {
          name,
          email,
          image: image || "",
          role: role || "attendee",
          createdAt: new Date(),
        };

        const result = await usersCollection.updateOne(
          { email },
          {
            $set: {
              name: user.name,
              image: user.image,
              role: user.role,
            },
            $setOnInsert: {
              email: user.email,
              createdAt: user.createdAt,
            },
          },
          {
            upsert: true,
          },
        );

        res.status(200).json({
          success: true,
          message: "User saved successfully.",
          acknowledged: result.acknowledged,
          upsertedId: result.upsertedId ?? null,
          matchedCount: result.matchedCount,
          modifiedCount: result.modifiedCount,
        });
      } catch (error) {
        console.error("USER CREATE ERROR:", error);

        res.status(500).json({
          success: false,
          message: "Internal Server Error.",
        });
      }
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
