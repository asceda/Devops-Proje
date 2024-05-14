const amqplib = require('amqplib');
const mysql = require('mysql2/promise');
require('dotenv').config();

(async () => {
  try {
    // RabbitMQ bağlantı ve kanal ayarları
    const connection = await amqplib.connect('amqp://localhost');
    const channel = await connection.createChannel();
    await channel.assertQueue('order_queue');

    // MySQL bağlantı ayarları
    const db = await mysql.createPool({
      host: process.env.MYSQL_HOST,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      port: process.env.MYSQL_PORT
    });

    // Siparişleri işleyen tüketici fonksiyonu
    const processOrder = async (msg) => {
      const orderData = JSON.parse(msg.content.toString());
      try {
        for (const item of orderData.items) {
          // Ürün tablosunda stoğu güncelleyin
          await db.query('UPDATE products SET stock = stock - ? WHERE id = ?', [item.quantity, item.product_id]);
        }
        // Siparişi işlenmiş olarak işaretleyin
        await db.query('UPDATE orders SET status = ? WHERE id = ?', ['processed', orderData.order_id]);
        console.log(`Sipariş ${orderData.order_id} başarıyla işlendi`);
        // Mesajı onaylayın
        channel.ack(msg);
      } catch (err) {
        console.error(`Sipariş ${orderData.order_id} işlenirken hata oluştu: ${err.message}`);
      }
    };

    // Sipariş kuyruğundan mesajları tüketin
    channel.consume('order_queue', processOrder);

  } catch (error) {
    console.error("Bir hata oluştu:", error);
  }
})();
