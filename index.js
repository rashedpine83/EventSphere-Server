"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const mongodb_1 = require("mongodb");
const jose_cjs_1 = require("jose-cjs");
const express_2 = require("express");
const stripe_1 = __importDefault(require("stripe"));
dotenv_1.default.config();
const port = process.env.PORT || 8000;
const stripe = new stripe_1.default(process.env.STRIPE_SECRET_KEY);
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
const uri = process.env.MONGODB_URI;
if (!uri) {
    throw new Error("MONGODB_URI is missing");
}
const client = new mongodb_1.MongoClient(uri, {
    serverApi: {
        version: mongodb_1.ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});
const JWKS = (0, jose_cjs_1.createRemoteJWKSet)(new URL(`${process.env.CLIENT_URL}/api/auth/jwks`));
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
        return res.status(401).json({
            success: false,
            message: "Unauthorized",
        });
    }
    const token = authHeader.split(" ")[1];
    try {
        const { payload } = await (0, jose_cjs_1.jwtVerify)(token, JWKS);
        req.user = {
            id: payload.sub,
            name: payload.name,
            email: payload.email,
        };
        next();
    }
    catch (error) {
        return res.status(403).json({
            success: false,
            message: "Invalid Token",
        });
    }
};
async function run() {
    try {
        // await client.connect();
        const database = client.db("EventSphere");
        const eventsCollection = database.collection("events");
        const registrationsCollection = database.collection("registrations");
        const usersCollection = database.collection("user");
        const wishsCollection = database.collection("wishs");
        app.post("/api/payment/create-checkout-session", verifyToken, async (req, res) => {
            try {
                const { registrationId } = req.body;
                if (!mongodb_1.ObjectId.isValid(registrationId)) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid Registration ID",
                    });
                }
                const registration = await registrationsCollection.findOne({
                    _id: new mongodb_1.ObjectId(registrationId),
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
            }
            catch (error) {
                console.error(error);
                res.status(500).json({
                    success: false,
                    message: "Stripe session creation failed.",
                });
            }
        });
        app.get("/api/payment/success", async (req, res) => {
            try {
                const sessionId = req.query.session_id;
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
                await registrationsCollection.updateOne({
                    _id: new mongodb_1.ObjectId(registrationId),
                }, {
                    $set: {
                        paymentStatus: "paid",
                        transactionId: session.payment_intent?.toString(),
                        paidAt: new Date(),
                    },
                });
                const registration = await registrationsCollection.findOne({
                    _id: new mongodb_1.ObjectId(registrationId),
                });
                res.status(200).json({
                    success: true,
                    registrationId,
                    ticketId: registration?._id,
                });
            }
            catch (error) {
                console.error(error);
                res.status(500).json({
                    success: false,
                    message: "Payment verification failed.",
                });
            }
        });
        app.post("/api/events/:id/register", verifyToken, async (req, res) => {
            try {
                const { id } = req.params;
                const { attendeeName, phone, address } = req.body;
                // ================= Validation =================
                if (!mongodb_1.ObjectId.isValid(id)) {
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
                    _id: new mongodb_1.ObjectId(id),
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
                const totalRegistration = await registrationsCollection.countDocuments({
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
            }
            catch (error) {
                console.error("Registration Error:", error);
                res.status(500).json({
                    success: false,
                    message: "Internal Server Error",
                });
            }
        });
        app.get("/api/registrations/:id", async (req, res) => {
            try {
                const { id } = req.params;
                if (!mongodb_1.ObjectId.isValid(id)) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid Registration ID",
                    });
                }
                const registration = await registrationsCollection.findOne({
                    _id: new mongodb_1.ObjectId(id),
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
            }
            catch (error) {
                console.error(error);
                return res.status(500).json({
                    success: false,
                    message: "Internal Server Error",
                });
            }
        });
        app.get("/api/my-bookings/:email", async (req, res) => {
            try {
                const { email } = req.params;
                const bookings = await registrationsCollection
                    .find({
                    attendeeEmail: email,
                })
                    .sort({ joinedAt: -1 })
                    .toArray();
                res.status(200).json({
                    success: true,
                    bookings,
                });
            }
            catch (error) {
                console.error(error);
                res.status(500).json({
                    success: false,
                    message: "Internal Server Error",
                });
            }
        });
        app.post("/api/events", verifyToken, async (req, res) => {
            try {
                const { title, description, category, location, eventDate, startTime, endTime, attendeeLimit, image, isPaid, ticketPrice, } = req.body;
                // Validation
                if (!title ||
                    !description ||
                    !category ||
                    !location ||
                    !eventDate ||
                    !image) {
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
            }
            catch (error) {
                console.error("Create Event Error:", error);
                return res.status(500).json({
                    success: false,
                    message: "Internal Server Error",
                });
            }
        });
        app.get("/api/events", async (req, res) => {
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
            }
            catch (error) {
                console.error(error);
                res.status(500).json({
                    success: false,
                    message: "Failed to fetch events.",
                });
            }
        });
        app.get("/api/my-events", verifyToken, async (req, res) => {
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
            }
            catch (error) {
                console.error(error);
                res.status(500).json({
                    success: false,
                    message: "Internal Server Error",
                });
            }
        });
        app.get("/api/events/:id", 
        // Optional middleware
        async (req, res) => {
            try {
                const { id } = req.params;
                if (!mongodb_1.ObjectId.isValid(id)) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid Event ID",
                    });
                }
                const event = await eventsCollection.findOne({
                    _id: new mongodb_1.ObjectId(id),
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
                const remainingSeats = Math.max(0, event.attendeeLimit - registeredCount);
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
            }
            catch (error) {
                console.error(error);
                res.status(500).json({
                    success: false,
                    message: "Internal Server Error",
                });
            }
        });
        app.get("/api/admin/events", async (req, res) => {
            try {
                const { page = "1", limit = "10", search = "", category = "", } = req.query;
                const pageNum = Number(page);
                const limitNum = Number(limit);
                const skip = (pageNum - 1) * limitNum;
                const query = {};
                if (search) {
                    query.title = {
                        $regex: search,
                        $options: "i",
                    };
                }
                if (category && category !== "All") {
                    query.category = category;
                }
                const events = await eventsCollection
                    .find(query)
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limitNum)
                    .toArray();
                const totalEvents = await eventsCollection.countDocuments(query);
                const totalPages = Math.ceil(totalEvents / limitNum);
                res.send({
                    success: true,
                    events,
                    totalEvents,
                    totalPages,
                    page: pageNum,
                });
            }
            catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });
        app.delete("/api/admin/events/:id", async (req, res) => {
            try {
                const { id } = req.params;
                if (!mongodb_1.ObjectId.isValid(id)) {
                    return res.status(400).send({
                        success: false,
                        message: "Invalid Event ID",
                    });
                }
                const result = await eventsCollection.deleteOne({
                    _id: new mongodb_1.ObjectId(id),
                });
                res.send({
                    success: true,
                    result,
                });
            }
            catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });
        app.patch("/api/admin/events/:id/status", async (req, res) => {
            try {
                const { id } = req.params;
                const { status } = req.body;
                if (!mongodb_1.ObjectId.isValid(id)) {
                    return res.status(400).send({
                        success: false,
                        message: "Invalid Event ID",
                    });
                }
                const result = await eventsCollection.updateOne({
                    _id: new mongodb_1.ObjectId(id),
                }, {
                    $set: {
                        status,
                    },
                });
                res.send({
                    success: true,
                    result,
                });
            }
            catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });
        app.patch("/api/events/:id", verifyToken, async (req, res) => {
            try {
                const { id } = req.params;
                if (!mongodb_1.ObjectId.isValid(id)) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid Event ID",
                    });
                }
                const existingEvent = await eventsCollection.findOne({
                    _id: new mongodb_1.ObjectId(id),
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
                const { title, description, category, location, eventDate, startTime, endTime, attendeeLimit, image, } = req.body;
                const result = await eventsCollection.updateOne({ _id: new mongodb_1.ObjectId(id) }, {
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
                });
                res.status(200).json({
                    success: true,
                    message: "Event updated successfully.",
                    result,
                });
            }
            catch (error) {
                console.error(error);
                res.status(500).json({
                    success: false,
                    message: "Internal Server Error",
                });
            }
        });
        app.delete("/api/events/:id", verifyToken, async (req, res) => {
            try {
                const { id } = req.params;
                if (!mongodb_1.ObjectId.isValid(id)) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid Event ID",
                    });
                }
                const existingEvent = await eventsCollection.findOne({
                    _id: new mongodb_1.ObjectId(id),
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
                    _id: new mongodb_1.ObjectId(id),
                });
                res.status(200).json({
                    success: true,
                    message: "Event deleted successfully.",
                    result,
                });
            }
            catch (error) {
                console.error(error);
                res.status(500).json({
                    success: false,
                    message: "Internal Server Error",
                });
            }
        });
        app.post("/api/users", async (req, res) => {
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
                const result = await usersCollection.updateOne({ email }, {
                    $set: {
                        name: user.name,
                        image: user.image,
                        role: user.role,
                    },
                    $setOnInsert: {
                        email: user.email,
                        createdAt: user.createdAt,
                    },
                }, {
                    upsert: true,
                });
                res.status(200).json({
                    success: true,
                    message: "User saved successfully.",
                    acknowledged: result.acknowledged,
                    upsertedId: result.upsertedId ?? null,
                    matchedCount: result.matchedCount,
                    modifiedCount: result.modifiedCount,
                });
            }
            catch (error) {
                console.error("USER CREATE ERROR:", error);
                res.status(500).json({
                    success: false,
                    message: "Internal Server Error.",
                });
            }
        });
        app.get("/api/users/:email", async (req, res) => {
            try {
                const { email } = req.params;
                const user = await usersCollection.findOne({ email });
                if (!user) {
                    return res.status(404).json({
                        success: false,
                        message: "User not found",
                    });
                }
                res.status(200).json({
                    success: true,
                    user,
                });
            }
            catch (error) {
                res.status(500).json({
                    success: false,
                    message: "Internal Server Error",
                });
            }
        });
        app.get("/api/users", async (req, res) => {
            try {
                const { page = "1", limit = "10", search = "", role = "" } = req.query;
                const pageNum = Number(page);
                const limitNum = Number(limit);
                const skip = (pageNum - 1) * limitNum;
                const query = {};
                if (search) {
                    query.$or = [
                        {
                            name: {
                                $regex: search,
                                $options: "i",
                            },
                        },
                        {
                            email: {
                                $regex: search,
                                $options: "i",
                            },
                        },
                    ];
                }
                if (role && role !== "All") {
                    query.role = role;
                }
                const users = await usersCollection
                    .find(query)
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limitNum)
                    .toArray();
                const totalUsers = await usersCollection.countDocuments(query);
                const totalPages = Math.ceil(totalUsers / limitNum);
                res.send({
                    success: true,
                    users,
                    totalUsers,
                    totalPages,
                    page: pageNum,
                });
            }
            catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });
        app.patch("/api/users/:id/role", async (req, res) => {
            try {
                const { id } = req.params;
                const { role } = req.body;
                if (!mongodb_1.ObjectId.isValid(id)) {
                    return res.status(400).send({
                        success: false,
                        message: "Invalid User ID",
                    });
                }
                const result = await usersCollection.updateOne({
                    _id: new mongodb_1.ObjectId(id),
                }, {
                    $set: {
                        role,
                    },
                });
                res.send({
                    success: true,
                    result,
                });
            }
            catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });
        app.patch("/api/users/:id/status", async (req, res) => {
            try {
                const { id } = req.params;
                const { status } = req.body;
                if (!mongodb_1.ObjectId.isValid(id)) {
                    return res.status(400).send({
                        success: false,
                        message: "Invalid User ID",
                    });
                }
                const result = await usersCollection.updateOne({
                    _id: new mongodb_1.ObjectId(id),
                }, {
                    $set: {
                        status,
                    },
                });
                res.send({
                    success: true,
                    result,
                });
            }
            catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });
        app.delete("/api/users/:id", async (req, res) => {
            try {
                const { id } = req.params;
                if (!mongodb_1.ObjectId.isValid(id)) {
                    return res.status(400).send({
                        success: false,
                        message: "Invalid User ID",
                    });
                }
                const result = await usersCollection.deleteOne({
                    _id: new mongodb_1.ObjectId(id),
                });
                res.send({
                    success: true,
                    result,
                });
            }
            catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });
        // app.get("/api/users", async (req: Request, res: Response) => {
        //   const users = await usersCollection.find().toArray();
        //   res.send(users);
        // });
        app.get("/api/wishlist/:email", async (req, res) => {
            try {
                const { email } = req.params;
                const wishlists = await wishsCollection
                    .find({
                    userEmail: email,
                })
                    .sort({ addedAt: -1 })
                    .toArray();
                res.status(200).json({
                    success: true,
                    wishlists,
                });
            }
            catch (error) {
                console.error(error);
                res.status(500).json({
                    success: false,
                    message: "Internal Server Error.",
                });
            }
        });
        app.post("/api/wishlist", async (req, res) => {
            try {
                const wishlist = req.body;
                if (!wishlist.eventId || !wishlist.userEmail) {
                    return res.status(400).json({
                        success: false,
                        message: "Event ID and User Email are required.",
                    });
                }
                const existing = await wishsCollection.findOne({
                    eventId: wishlist.eventId,
                    userEmail: wishlist.userEmail,
                });
                if (existing) {
                    return res.status(200).json({
                        success: true,
                        message: "Already added to wishlist.",
                    });
                }
                const newWishlist = {
                    eventId: wishlist.eventId,
                    eventTitle: wishlist.eventTitle,
                    eventCategory: wishlist.eventCategory,
                    eventImage: wishlist.eventImage,
                    eventDate: wishlist.eventDate,
                    location: wishlist.location,
                    isPaid: wishlist.isPaid,
                    ticketPrice: wishlist.ticketPrice,
                    organizerName: wishlist.organizerName,
                    organizerEmail: wishlist.organizerEmail,
                    userEmail: wishlist.userEmail,
                    addedAt: new Date(),
                };
                const result = await wishsCollection.insertOne(newWishlist);
                res.status(201).json({
                    success: true,
                    insertedId: result.insertedId,
                    message: "Added to wishlist successfully.",
                });
            }
            catch (error) {
                console.error(error);
                res.status(500).json({
                    success: false,
                    message: "Internal Server Error.",
                });
            }
        });
        app.delete("/api/wishlist/:id", async (req, res) => {
            try {
                const { id } = req.params;
                if (!mongodb_1.ObjectId.isValid(id)) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid Wishlist ID.",
                    });
                }
                const result = await wishsCollection.deleteOne({
                    _id: new mongodb_1.ObjectId(id),
                });
                res.status(200).json({
                    success: true,
                    deletedCount: result.deletedCount,
                    message: "Removed from wishlist.",
                });
            }
            catch (error) {
                console.error(error);
                res.status(500).json({
                    success: false,
                    message: "Internal Server Error.",
                });
            }
        });
        app.get("/api/admin/dashboard", async (req, res) => {
            try {
                const totalUsers = await usersCollection.countDocuments();
                const totalEvents = await eventsCollection.countDocuments();
                const totalBookings = await registrationsCollection.countDocuments();
                const totalWishlist = await wishsCollection.countDocuments();
                const totalOrganizers = await usersCollection.countDocuments({
                    role: "organizer",
                });
                const totalAttendees = await usersCollection.countDocuments({
                    role: "attendee",
                });
                const revenueResult = await registrationsCollection
                    .aggregate([
                    {
                        $match: {
                            paymentStatus: "paid",
                        },
                    },
                    {
                        $group: {
                            _id: null,
                            total: {
                                $sum: "$ticketPrice",
                            },
                        },
                    },
                ])
                    .toArray();
                const revenue = revenueResult.length > 0 ? revenueResult[0].total : 0;
                const categoryData = await eventsCollection
                    .aggregate([
                    {
                        $group: {
                            _id: "$category",
                            count: {
                                $sum: 1,
                            },
                        },
                    },
                    {
                        $sort: {
                            count: -1,
                        },
                    },
                ])
                    .toArray();
                const latestEvents = await eventsCollection
                    .find()
                    .sort({
                    createdAt: -1,
                })
                    .limit(5)
                    .toArray();
                const latestUsers = await usersCollection
                    .find()
                    .sort({
                    createdAt: -1,
                })
                    .limit(5)
                    .toArray();
                res.send({
                    success: true,
                    stats: {
                        totalUsers,
                        totalEvents,
                        totalBookings,
                        totalWishlist,
                        totalOrganizers,
                        totalAttendees,
                        revenue,
                    },
                    categoryData,
                    latestEvents,
                    latestUsers,
                });
            }
            catch (error) {
                console.error(error);
                res.status(500).send({
                    success: false,
                    message: "Dashboard data load failed.",
                });
            }
        });
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    }
    finally {
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
//# sourceMappingURL=index.js.map