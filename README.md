# UI Dashboard - Backend Service

## 📋 Overview
The backend service powers the UI Dashboard application, handling data processing, API requests, and business logic. Built with Node.js and Express, it provides a robust and scalable foundation for the frontend application.

## 🏗️ Architecture
```
backend/
├── config/           # Configuration files
├── controllers/      # Request handlers
├── middleware/       # Custom middleware
├── models/           # Data models
├── routes/          # API route definitions
├── services/        # Business logic
├── utils/           # Helper functions
├── validators/      # Request validation
├── .env            # Environment variables
├── server.js       # Main application entry
└── package.json    # Dependencies and scripts
```

## 🚀 Features
- **RESTful API**: Clean, consistent endpoints
- **Authentication**: JWT-based auth system
- **Caching**: Redis integration for performance
- **Validation**: Request validation
- **Logging**: Request/error logging
- **Error Handling**: Global error handling
- **Security**: CORS, rate limiting

## 🛠️ Prerequisites
- Node.js v18+
- npm v9+ or yarn
- Redis 6.0+

## ⚙️ Setup
1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Environment Setup**
   ```bash
   cp .env.example .env
   # Update .env with your configuration
   ```

3. **Start Redis**
   - Install Redis if needed
   - Start Redis server

## 🚦 Environment Variables
```env
# Server
PORT=3001
NODE_ENV=development
```

## 🏃‍♂️ Running the Server
- Development: `npm run dev`
- Production: `npm start`
- Test: `npm test`

## 🔄 Database
- **Redis**: Used for caching and session storage
- **Connection**: Configured in server.js

## 🔒 Authentication
- JWT-based authentication
- Protected routes require valid token
- Token expiration: 24 hours

## 📦 Dependencies
- Express: Web framework
- Redis: Caching
- JWT: Authentication
- Winston: Logging
- Joi: Validation

## 🤝 Contributing
1. Fork the repository
2. Create your feature branch
3. Commit changes
4. Push to branch
5. Create Pull Request
