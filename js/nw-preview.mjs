// In-memory stand-in for the Supabase client. Loaded only on localhost when
// the page is opened with ?nwtest=1. It never calls the network.

const PREVIEW_USER = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "walker@example.com",
};

function uuid() {
  return crypto.randomUUID();
}

function stripWalk(row) {
  return {
    id: row.id,
    name: row.name,
    route_mode: row.route_mode,
    route_geojson: row.route_geojson,
    distance_m: row.distance_m,
    duration_s: row.duration_s,
    created_at: row.created_at,
  };
}

function stripReport(row) {
  return {
    id: row.id,
    category: row.category,
    lat: row.lat,
    lng: row.lng,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

function denied(table) {
  return {
    data: null,
    error: { code: "42501", message: `permission denied for table ${table}` },
  };
}

export function createPreviewClient() {
  const walks = [
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      user_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      name: "Someone else's walk home",
      route_mode: "safest",
      route_geojson: {
        type: "Feature",
        geometry: { type: "LineString", coordinates: [[-0.2, 51.5], [-0.19, 51.51]] },
        properties: {},
      },
      distance_m: 900,
      duration_s: 700,
      created_at: new Date().toISOString(),
    },
  ];
  const now = Date.now();
  const reports = [
    {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      owner: null,
      category: "lighting",
      lat: 51.513,
      lng: -0.098,
      status: "approved",
      created_at: new Date(now - 3600000).toISOString(),
      expires_at: new Date(now + 36 * 3600000).toISOString(),
    },
    {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      owner: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      category: "blocked-path",
      lat: 51.52,
      lng: -0.11,
      status: "pending",
      created_at: new Date(now - 600000).toISOString(),
      expires_at: new Date(now + 20 * 3600000).toISOString(),
    },
  ];
  let session = null;
  const listeners = new Set();
  const channels = [];
  let lastReportId = null;

  function emitAuth(event) {
    for (const cb of listeners) cb(event, session);
  }

  function emitReport(payload) {
    for (const channel of channels) {
      for (const handler of channel.handlers) handler.cb(payload);
    }
  }

  function visibleReports() {
    const t = Date.now();
    const userId = session?.user?.id || null;
    return reports
      .filter((row) => {
        const live = Date.parse(row.expires_at) > t;
        if (row.status === "approved" && live) return true;
        return Boolean(userId && row.owner === userId);
      })
      .map(stripReport);
  }

  function execute(table, op, payload, eq) {
    if (table === "saved_walks") {
      if (!session) return denied(table);
      if (op === "select") {
        return {
          data: walks.filter((row) => row.user_id === session.user.id).map(stripWalk),
          error: null,
        };
      }
      if (op === "insert") {
        const row = {
          id: uuid(),
          user_id: session.user.id,
          name: payload.name,
          route_mode: payload.route_mode,
          route_geojson: payload.route_geojson,
          distance_m: payload.distance_m,
          duration_s: payload.duration_s,
          created_at: new Date().toISOString(),
        };
        walks.unshift(row);
        return { data: null, error: null };
      }
      if (op === "update") {
        const row = walks.find((item) => item.id === eq?.val && item.user_id === session.user.id);
        if (!row) return { data: null, error: null };
        row.name = payload.name;
        return { data: null, error: null };
      }
      if (op === "delete") {
        const index = walks.findIndex((item) => item.id === eq?.val && item.user_id === session.user.id);
        if (index >= 0) walks.splice(index, 1);
        return { data: null, error: null };
      }
    }
    if (table === "community_reports") {
      if (op === "select") return { data: visibleReports(), error: null };
      if (op === "insert") {
        if (!session) return denied(table);
        const row = {
          id: uuid(),
          owner: session.user.id,
          category: payload.category,
          lat: payload.lat,
          lng: payload.lng,
          status: "pending",
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 48 * 3600000).toISOString(),
        };
        reports.push(row);
        lastReportId = row.id;
        const clean = stripReport(row);
        emitReport({ eventType: "INSERT", new: clean, old: {} });
        return { data: null, error: null };
      }
      return denied(table);
    }
    return { data: null, error: { message: "unknown table" } };
  }

  function from(table) {
    let op = "select";
    let payload = null;
    let eq = null;
    const api = {
      insert(row) {
        op = "insert";
        payload = row;
        return api;
      },
      update(row) {
        op = "update";
        payload = row;
        return api;
      },
      delete() {
        op = "delete";
        return api;
      },
      select() {
        return api;
      },
      eq(col, val) {
        eq = { col, val };
        return api;
      },
      order() {
        return api;
      },
      then(resolve, reject) {
        return Promise.resolve(execute(table, op, payload, eq)).then(resolve, reject);
      },
    };
    return api;
  }

  const client = {
    auth: {
      async signUp({ email }) {
        if (String(email).endsWith("@taken.test")) {
          return {
            data: { user: { id: PREVIEW_USER.id, identities: [], email }, session: null },
            error: null,
          };
        }
        return {
          data: {
            user: { id: PREVIEW_USER.id, email, identities: [{ id: "identity" }] },
            session: null,
          },
          error: null,
        };
      },
      async signInWithPassword({ email, password }) {
        if (password === "wrong-password") {
          return { data: { session: null, user: null }, error: { message: "Invalid login credentials" } };
        }
        if (String(email).startsWith("unconfirmed@")) {
          return { data: { session: null, user: null }, error: { message: "Email not confirmed" } };
        }
        session = { user: { ...PREVIEW_USER, email } };
        emitAuth("SIGNED_IN");
        return { data: { session, user: session.user }, error: null };
      },
      async resend() {
        return { data: {}, error: null };
      },
      async resetPasswordForEmail() {
        return { data: {}, error: null };
      },
      async signOut() {
        session = null;
        emitAuth("SIGNED_OUT");
        return { error: null };
      },
      onAuthStateChange(callback) {
        listeners.add(callback);
        setTimeout(() => callback("INITIAL_SESSION", session), 0);
        return { data: { subscription: { unsubscribe() { listeners.delete(callback); } } } };
      },
    },
    from,
    channel(name) {
      const channel = { name, handlers: [] };
      channels.push(channel);
      return {
        on(_type, _filter, cb) {
          channel.handlers.push({ cb });
          return this;
        },
        subscribe(cb) {
          channel.status = cb;
          setTimeout(() => cb?.("SUBSCRIBED"), 0);
          return channel;
        },
      };
    },
    async removeChannel(channel) {
      const index = channels.indexOf(channel);
      if (index >= 0) channels.splice(index, 1);
      return "ok";
    },
    __lastReportId() {
      return lastReportId;
    },
    __seedExpiring(ms) {
      const row = {
        id: uuid(),
        owner: null,
        category: "blocked-path",
        lat: 51.49,
        lng: -0.14,
        status: "approved",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + ms).toISOString(),
      };
      reports.push(row);
      const clean = stripReport(row);
      emitReport({ eventType: "INSERT", new: clean, old: {} });
      return row.id;
    },
    __moderate(id, patch) {
      const row = reports.find((item) => item.id === id);
      if (!row) return null;
      Object.assign(row, patch);
      const clean = stripReport(row);
      emitReport({ eventType: "UPDATE", new: clean, old: { id: row.id } });
      return clean;
    },
  };
  return client;
}
