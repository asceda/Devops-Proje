const express = require('express');
const mysql = require('mysql2/promise');
const redis = require('redis');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { MongoClient } = require('mongodb');
const amqplib = require('amqplib');
require('dotenv').config();
// Express app setup
const app = express();
app.use(express.json());
// MySQL connection setup
const db = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: process.env.MYSQL_PORT
});
// Redis client setup
const redisClient = redis.createClient({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT
});
redisClient.on('error', (err) => console.error(`Redis error: ${err}`));
// MongoDB setup
const client = new MongoClient(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
let reviewsCollection;
async function connectMongoDB() {
  try {
    await client.connect();
    const database = client.db(process.env.MONGODB_DB_NAME);
    reviewsCollection = database.collection('reviews');
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('Error connecting to MongoDB:', err);
  }
}
connectMongoDB();
// RabbitMQ setup
let channel;
(async () => {
  const connection = await amqplib.connect('amqp://localhost');
  channel = await connection.createChannel();
  await channel.assertQueue('order_queue');
})();
// User registration
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  try {
    const [result] = await db.query('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hashedPassword]);
    res.status(201).json({ message: 'User registered successfully', userId: result.insertId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// User login
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
    if (rows.length === 0) return res.status(401).json({ message: 'Invalid credentials' });
    const user = rows[0];
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) return res.status(401).json({ message: 'Invalid credentials' });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    redisClient.setex(user.id, 3600, token);
    res.json({ message: 'Login successful', token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Middleware to verify JWT token
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ message: 'Failed to authenticate token' });
    redisClient.get(decoded.userId.toString(), (err, storedToken) => {
      if (err || token !== storedToken) return res.status(401).json({ message: 'Session expired or invalid' });
      req.userId = decoded.userId;
      next();
    });
  });
};
// Protected profile route
app.get('/profile', verifyToken, (req, res) => {
  res.json({ message: 'Profile data', userId: req.userId });
});
// Product management
app.post('/products', async (req, res) => {
  const { name, price, stock } = req.body;
  try {
    const [result] = await db.query('INSERT INTO products (name, price, stock) VALUES (?, ?, ?)', [name, price, stock]);
    res.status(201).json({ message: 'Product added successfully', productId: result.insertId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.get('/products', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM products');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Order placement and processing
app.post('/orders', async (req, res) => {
  const { user_id, items } = req.body;
  let total = 0;
  const orderItems = [];
  try {
    for (const item of items) {
      const [rows] = await db.query('SELECT * FROM products WHERE id = ?', [item.product_id]);
      if (rows.length === 0) return res.status(400).json({ error: 'Invalid product' });
      const product = rows[0];
      if (item.quantity > product.stock) return res.status(400).json({ error: 'Insufficient stock' });
      total += item.quantity * product.price;
      orderItems.push({ ...item, price: product.price });
    }
    const [orderResult] = await db.query('INSERT INTO orders (user_id, total) VALUES (?, ?)', [user_id, total]);
    for (const item of orderItems) {
      await db.query('INSERT INTO order_items (order_id, product_id, quantity) VALUES (?, ?, ?)', [orderResult.insertId, item.product_id, item.quantity]);
    }
    const orderData = { order_id: orderResult.insertId, items: orderItems };
    channel.sendToQueue('order_queue', Buffer.from(JSON.stringify(orderData)));
    res.status(201).json({ message: 'Order placed successfully', orderId: orderResult.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Add a comment and rating to a product
app.post('/products/:id/comments', async (req, res) => {
  const productId = req.params.id;
  const { user_id, comment, rating } = req.body;
  try {
    const commentDoc = {
      productId,
      user_id,
      comment,
      rating,
      created_at: new Date()
    };
    const result = await reviewsCollection.insertOne(commentDoc);
    res.status(201).json({ message: 'Comment added successfully', commentId: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Get all comments for a product
app.get('/products/:id/comments', async (req, res) => {
  const productId = req.params.id;
  try {
    const comments = await reviewsCollection.find({ productId }).toArray();
    res.json(comments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Start server
app.listen(3000, () => console.log('Server running on port 3000'));


