const net = require("node:net");

const blockedConnections = [];
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const connectionArgs = Array.isArray(args[0]) ? args[0] : args;
  const options = connectionArgs[0];
  const host =
    typeof options === "object"
      ? options.host || "localhost"
      : typeof connectionArgs[1] === "string"
        ? connectionArgs[1]
        : "localhost";
  if (!["localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(host)) {
    blockedConnections.push(true);
    if (require.main === module && process.connected) {
      process.send({ blockedNetwork: true });
    }
    throw new Error("Protocol tests forbid non-loopback network connections.");
  }
  return connect.apply(this, args);
};

module.exports = { blockedConnections };

if (require.main === module) {
  require("appium")
    .main({
      address: "127.0.0.1",
      port: 0,
      appiumHome: process.env.APPIUM_HOME,
      useDrivers: ["revyl"],
      usePlugins: [],
      basePath: "/",
      logLevel: "error",
      keepAliveTimeout: 1,
      requestTimeout: 5,
    })
    .then((server) => {
      if (!server?.listening) throw new Error("Appium did not start a server.");
      process.send({ port: server.address().port });
    })
    .catch((error) => {
      process.send({ error: error.message });
      process.exitCode = 1;
    });
}
