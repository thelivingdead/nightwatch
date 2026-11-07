export function createRecorder(handlers = {}) {
  const calls = [];

  function finish(call) {
    if (handlers.resolve) return handlers.resolve(call);
    return { data: call.op === "select" ? [] : null, error: null };
  }

  function builder(table) {
    const call = { table, op: null, payload: undefined, select: null, eq: null, order: null };
    calls.push(call);
    const api = {
      insert(row) {
        call.op = "insert";
        call.payload = row;
        return api;
      },
      update(row) {
        call.op = "update";
        call.payload = row;
        return api;
      },
      delete() {
        call.op = "delete";
        return api;
      },
      select(cols) {
        call.op = call.op || "select";
        call.select = cols;
        return api;
      },
      eq(col, val) {
        call.eq = { col, val };
        return api;
      },
      order(col, opts) {
        call.order = { col, opts };
        return api;
      },
      then(resolve, reject) {
        return Promise.resolve(finish(call)).then(resolve, reject);
      },
    };
    return api;
  }

  const channels = [];
  return {
    calls,
    channels,
    auth: {
      async signUp(body) {
        calls.push({ op: "signUp", body });
        return handlers.signUp ? handlers.signUp(body) : {
          data: { user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", identities: [{ id: "id" }] }, session: null },
          error: null,
        };
      },
      async signInWithPassword(body) {
        calls.push({ op: "signInWithPassword", body });
        return handlers.signIn ? handlers.signIn(body) : {
          data: { session: { user: { email: body.email } }, user: { email: body.email } },
          error: null,
        };
      },
      async resend(body) {
        calls.push({ op: "resend", body });
        return { data: {}, error: null };
      },
      async resetPasswordForEmail(email, options) {
        calls.push({ op: "resetPasswordForEmail", email, options });
        return { data: {}, error: null };
      },
      async signOut(options) {
        calls.push({ op: "signOut", options });
        return { error: null };
      },
    },
    from: builder,
    channel(name) {
      const channel = {
        name,
        filter: null,
        handler: null,
        status: null,
        on(type, filter, cb) {
          channel.event = type;
          channel.filter = filter;
          channel.handler = cb;
          return channel;
        },
        subscribe(cb) {
          channel.status = cb;
          return channel;
        },
      };
      channels.push(channel);
      calls.push({ op: "channel", name });
      return channel;
    },
    async removeChannel(channel) {
      calls.push({ op: "removeChannel", name: channel?.name });
      return "ok";
    },
  };
}
