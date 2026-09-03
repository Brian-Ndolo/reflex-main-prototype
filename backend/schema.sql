-- ============================================================
--  Reflex Deliveries — MySQL Schema
--  Run this once in HostAfrica phpMyAdmin or via MySQL CLI
-- ============================================================

-- USERS table
CREATE TABLE IF NOT EXISTS users (
  id       VARCHAR(20)  NOT NULL PRIMARY KEY,
  name     VARCHAR(100) NOT NULL,
  role     ENUM('retailer','dispatcher','rider') NOT NULL,
  email    VARCHAR(150) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  phone    VARCHAR(20)  NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- DELIVERIES table
CREATE TABLE IF NOT EXISTS deliveries (
  id                 VARCHAR(20)   NOT NULL PRIMARY KEY,
  retailerId         VARCHAR(20)   NOT NULL,
  customerName       VARCHAR(100)  NOT NULL,
  customerPhone      VARCHAR(20)   NOT NULL,
  address            VARCHAR(255)  NOT NULL,
  item               VARCHAR(255)  NOT NULL,
  riderId            VARCHAR(20)   NULL,
  status             VARCHAR(30)   NOT NULL DEFAULT 'Open',
  paymentStatus      VARCHAR(32)   NOT NULL DEFAULT 'UNPAID',
  mpesaRef           VARCHAR(64)   NULL,
  deliveryOtp        VARCHAR(6)    NULL,
  podToken           VARCHAR(64)   NULL,
  verificationMethod VARCHAR(20)   NULL,
  verifiedAt         DATETIME      NULL,
  createdAt          DATETIME      NOT NULL,
  updatedAt          DATETIME      NOT NULL,
  FOREIGN KEY (retailerId) REFERENCES users(id),
  FOREIGN KEY (riderId)    REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- DELIVERY HISTORY table
CREATE TABLE IF NOT EXISTS delivery_history (
  id           INT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  deliveryId   VARCHAR(20)   NOT NULL,
  status       VARCHAR(30)   NOT NULL,
  at_time      DATETIME      NOT NULL,
  note         VARCHAR(255)  NOT NULL DEFAULT '',
  FOREIGN KEY (deliveryId) REFERENCES deliveries(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
--  Seed Data (matches original db.json)
-- ============================================================
INSERT IGNORE INTO users (id, name, role, email, password, phone) VALUES
  ('u1', 'Jane Retailer',      'retailer',   'jane@gmail.com',          '123456', '0711000001'),
  ('u2', 'David Dispatcher',   'dispatcher', 'dispatcher@reflex.com',   '123456', '0711000002'),
  ('u3', 'Brian Rider',        'rider',       'brian@gmail.com',         '123456', '0711000003'),
  ('u4', 'Mercy Rider',        'rider',       'mercy@gmail.com',         '123456', '0711000004');

INSERT IGNORE INTO deliveries (id, retailerId, customerName, customerPhone, address, item, riderId, status, createdAt, updatedAt) VALUES
  ('DEL-1001','u1','Mary Wanjiku','0712345678','Kitengela, Kajiado','Phone charger',  'u3','Out for Delivery','2026-08-30 08:30:00','2026-08-30 09:30:00'),
  ('DEL-1002','u1','Peter Otieno','0723456789','Athi River',        'Bluetooth speaker','u4','Picked Up',      '2026-08-30 09:15:00','2026-08-31 05:09:40');

INSERT IGNORE INTO delivery_history (deliveryId, status, at_time, note) VALUES
  ('DEL-1001','Open',            '2026-08-30 08:30:00','Delivery created by business owner'),
  ('DEL-1001','Assigned',        '2026-08-30 09:00:00','Accepted by Brian Rider'),
  ('DEL-1001','Picked Up',       '2026-08-30 09:15:00','Status updated by rider'),
  ('DEL-1001','Out for Delivery','2026-08-30 09:30:00','Status updated by rider'),
  ('DEL-1002','Open',            '2026-08-30 09:15:00','Delivery created by business owner'),
  ('DEL-1002','Assigned',        '2026-08-31 04:28:41','Accepted by Mercy Rider'),
  ('DEL-1002','Picked Up',       '2026-08-31 05:09:40','Status updated by rider');
