// src/services/courtService.js
const Court = require('../models/court.model');

const getCourtSummary = async (companyId = null) => {
    try {
        const courts = await Court.find({
            isActive: true,
            companyId: companyId || null,
        });

        if (courts.length === 0) return { info: "No hay canchas.", areDifferent: false };

        // Agrupamos por courtType
        const typeGroups = {};
        for (const c of courts) {
            const type = c.courtType || "Estándar";
            if (!typeGroups[type]) typeGroups[type] = [];
            typeGroups[type].push(c.name);
        }

        const uniqueTypes = Object.keys(typeGroups);
        const areDifferent = uniqueTypes.length > 1;

        let instructions = "";

        if (areDifferent) {
            const typeList = uniqueTypes.map(t => `"${t}" (${typeGroups[t].join(', ')})`).join(', ');
            instructions = `
            [SITUACIÓN: CANCHAS DIFERENTES]
            - Tenemos los siguientes tipos de cancha: ${typeList}.
            - SI EL USUARIO NO ESPECIFICA EL TIPO, DEBES PREGUNTAR cuál prefiere mencionando los tipos disponibles.
            - Cuando el usuario elija un tipo, manda "courtName": "<tipo exacto>" (ej: "Techada").
            - El sistema asignará automáticamente la cancha libre de ese tipo.
            - Solo manda el nombre de una cancha específica si el usuario pide una cancha puntual por nombre.
            `;
        } else {
            instructions = `
            [SITUACIÓN: CANCHAS IGUALES]
            - Todas las canchas son del mismo tipo (${uniqueTypes[0]}).
            - NO PREGUNTES "¿Qué cancha querés?". ES MOLESTO.
            - Si el usuario pide turno, asume que le da igual.
            - En el JSON, manda "courtName": "INDIFERENTE".
            `;
        }

        return { instructions, areDifferent, typeGroups };

    } catch (error) {
        console.error(error);
        return { instructions: "", areDifferent: false, typeGroups: {} };
    }
};

module.exports = { getCourtSummary };
