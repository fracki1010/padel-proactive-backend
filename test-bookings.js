const axios = require("axios");
async function test() {
  const res = await axios.get(
    "http://localhost:3000/api/bookings?date=2026-03-17",
  );
  console.log(JSON.stringify(res.data, null, 2));
}
test();
