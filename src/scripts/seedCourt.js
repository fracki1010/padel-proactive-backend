require('dotenv').config();
const mongoose = require('mongoose');
const TimeSlot = require('../models/timeSlot.model');
const Court = require('../models/court.model');
const connectDB = require('../config/database');

const seed = async () => {
    await connectDB();

    console.log('🧹 Limpiando base de datos...');
    await TimeSlot.deleteMany({});
    await Court.deleteMany({});

    // 1. Crear Canchas
    const courts = await Court.create([
        { name: 'Cancha 1' },
        { name: 'Cancha 2' }
    ]);
    console.log('✅ Canchas creadas.');

    // 2. Crear Turnos Fijos (Ejemplo de lógica de negocio)
    // Definimos los bloques de 1h 30m
    const slotsData = [
        { startTime: "14:00", endTime: "15:30", price: 24000, order: 1 },
        { startTime: "15:30", endTime: "17:00", price: 24000, order: 2 },
        { startTime: "17:00", endTime: "18:30", price: 28000, order: 3 }, // Pico
        { startTime: "18:30", endTime: "20:00", price: 28000, order: 4 }, // Pico
        { startTime: "20:00", endTime: "21:30", price: 28000, order: 5 }, // Pico
        { startTime: "21:30", endTime: "23:00", price: 28000, order: 6 }, // Pico
    ];

    await TimeSlot.insertMany(slotsData);
    console.log('✅ Turnos fijos creados (TimeSlots).');

    process.exit();
};

seed();