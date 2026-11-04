"use strict";

const express = require("express");

/**
 * Rotas administrativas para a API XCast.
 * As credenciais permanecem exclusivamente no servidor.
 */
function criarRotasXCast({ exigirAdmin }) {
  const router = express.Router();
  const BASE = (process.env.XCAST_API_BASE || "https://beta.xcast.com.br/api-v2")
    .replace(/\/+$/, "");

  function configuracao() {
    return {
      publicKey: process.env.XCAST_PUBLIC_KEY || "",
      apiKey: process.env.XCAST_API_KEY || ""
    };
  }

  function validarConfiguracao(res) {
    const { publicKey, apiKey } = configuracao();
    if (!publicKey || !apiKey) {
      res.status(503).json({
        erro: "Integração XCast não configurada. Confira XCAST_PUBLIC_KEY e XCAST_API_KEY nas variáveis do Render."
      });
      return null;
    }
    if (!/^[a-zA-Z0-9_-]{2,160}$/.test(publicKey)) {
      res.status(503).json({ erro: "A chave pública da rádio no XCast tem formato inválido." });
      return null;
    }
    return { publicKey, apiKey };
  }

  async function xcast(res, endpoint, options = {}) {
    const credenciais = validarConfiguracao(res);
    if (!credenciais) return null;

    const url = `${BASE}/${endpoint.replace(/^\/+/, "")}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const headers = {
        Authorization: `Bearer ${credenciais.apiKey}`,
        Accept: "application/json"
      };
      if (options.body instanceof URLSearchParams) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      } else if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      const resposta = await fetch(url, {
        method: options.method || "GET",
        headers,
        body: options.body === undefined
          ? undefined
          : options.body instanceof URLSearchParams
            ? options.body.toString()
            : JSON.stringify(options.body),
        signal: controller.signal
      });

      const bruto = await resposta.text();
      let dados;
      try { dados = bruto ? JSON.parse(bruto) : {}; }
      catch { dados = { resposta: bruto.slice(0, 5000) }; }

      if (!resposta.ok) {
        const mensagem =
          (dados && (dados.erro || dados.error || dados.mensagem || dados.message)) ||
          `A XCast respondeu com HTTP ${resposta.status}.`;
        res.status(resposta.status >= 400 && resposta.status < 500 ? resposta.status : 502)
          .json({ erro: String(mensagem).slice(0, 500), detalhe: dados });
        return null;
      }
      return dados;
    } catch (err) {
      const abortou = err.name === "AbortError";
      res.status(502).json({
        erro: abortou
          ? "A XCast demorou para responder. Tente novamente."
          : "Não foi possível comunicar com a XCast."
      });
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  function enviar(res, dados) {
    if (dados !== null) res.json(dados);
  }

  function caminhoPublico(sufixo) {
    return `${sufixo}/${encodeURIComponent(process.env.XCAST_PUBLIC_KEY || "")}`;
  }

  router.use(exigirAdmin);

  router.get("/config", (req, res) => {
    const { publicKey, apiKey } = configuracao();
    res.json({ configurado: Boolean(publicKey && apiKey) });
  });

  const leituras = {
    status: () => caminhoPublico("status"),
    "tocando-agora": () => caminhoPublico("now-playing"),
    capa: () => caminhoPublico("capa"),
    historico: () => caminhoPublico("historico"),
    uptime: () => caminhoPublico("uptime"),
    resumo: () => caminhoPublico("resumo"),
    mapa: () => caminhoPublico("mapa"),
    "top-musicas": () => caminhoPublico("top-musicas"),
    "ouvintes-hora": () => caminhoPublico("ouvintes-hora"),
    execucoes: () => caminhoPublico("execucoes"),
    pedidos: () => caminhoPublico("pedidos"),
    playlists: () => caminhoPublico("playlists"),
    agendamentos: () => caminhoPublico("agendamentos"),
    dj: () => caminhoPublico("dj"),
    acervo: () => caminhoPublico("acervo")
  };

  for (const [nome, montar] of Object.entries(leituras)) {
    router.get(`/${nome}`, async (req, res) => {
      if (nome === "acervo" && req.query.pasta !== undefined) {
        const pasta = String(req.query.pasta);
        if (pasta.length > 150 || /[\r\n]/.test(pasta)) {
          return res.status(400).json({ erro: "Nome de pasta inválido." });
        }
      }
      let endpoint = montar();
      if (nome === "acervo" && req.query.pasta) {
        endpoint += `?pasta=${encodeURIComponent(String(req.query.pasta))}`;
      }
      enviar(res, await xcast(res, endpoint));
    });
  }

  router.get("/playlists/:id", async (req, res) => {
    const id = String(req.params.id);
    if (!/^\d{1,12}$/.test(id)) return res.status(400).json({ erro: "Playlist inválida." });
    enviar(res, await xcast(res, `${caminhoPublico("playlist")}/${id}`));
  });

  router.get("/tts-cota", async (req, res) => {
    enviar(res, await xcast(res, caminhoPublico("tts-cota")));
  });

  router.get("/relatorio/:tipo", async (req, res) => {
    const tipos = new Set(["diario", "semanal", "mensal", "anual"]);
    if (!tipos.has(req.params.tipo)) {
      return res.status(400).json({ erro: "Tipo de relatório inválido." });
    }
    enviar(res, await xcast(res, `relatorio/${encodeURIComponent(process.env.XCAST_PUBLIC_KEY || "")}/${req.params.tipo}`));
  });

  // Ações aceitas explicitamente; não existe proxy de URL arbitrária.
  const acoesSimples = {
    "ligar-streaming": "ligar-streaming",
    "desligar-streaming": "desligar-streaming",
    "ligar-autodj": "ligar-autodj",
    "desligar-autodj": "desligar-autodj",
    "pular-musica": "pular-musica",
    "disparar-conteudo": "disparar-conteudo",
    "recarregar-playlist": "recarregar-playlist"
  };

  for (const [acao, endpoint] of Object.entries(acoesSimples)) {
    router.post(`/acao/${acao}`, async (req, res) => {
      const dados = await xcast(res, caminhoPublico(endpoint), { method: "POST", body: new URLSearchParams() });
      enviar(res, dados);
    });
  }

  router.post("/acao/trocar-playlist", async (req, res) => {
    const id = String(req.body?.playlistId ?? "");
    if (!/^\d{1,12}$/.test(id)) return res.status(400).json({ erro: "Selecione uma playlist válida." });
    enviar(res, await xcast(res, `${caminhoPublico("trocar-playlist")}/trocar/${id}`, {
      method: "POST", body: new URLSearchParams()
    }));
  });

  router.post("/playlists/criar", async (req, res) => {
    const nome = req.body?.nome;
    if (typeof nome !== "string" || !nome.trim() || nome.trim().length > 150) {
      return res.status(400).json({ erro: "Informe um nome de playlist com até 150 caracteres." });
    }
    enviar(res, await xcast(res, caminhoPublico("playlist-criar"), {
      method: "POST", body: new URLSearchParams({ nome: nome.trim() })
    }));
  });

  router.post("/playlists/:id/renomear", async (req, res) => {
    const id = String(req.params.id);
    const nome = req.body?.nome;
    if (!/^\d{1,12}$/.test(id) || typeof nome !== "string" || !nome.trim() || nome.trim().length > 150) {
      return res.status(400).json({ erro: "Confira o identificador e o novo nome." });
    }
    enviar(res, await xcast(res, `${caminhoPublico("playlist-renomear")}/${id}`, {
      method: "POST", body: new URLSearchParams({ nome: nome.trim() })
    }));
  });

  router.delete("/playlists/:id", async (req, res) => {
    const id = String(req.params.id);
    if (!/^\d{1,12}$/.test(id)) return res.status(400).json({ erro: "Playlist inválida." });
    const form = new URLSearchParams();
    if (req.query.forcar === "1") form.set("forcar", "1");
    enviar(res, await xcast(res, `${caminhoPublico("playlist-excluir")}/${id}`, { method: "POST", body: form }));
  });

  router.post("/playlists/:id/adicionar", async (req, res) => {
    const id = String(req.params.id);
    const musicas = req.body?.musicas;
    const pasta = req.body?.pasta;
    if (!/^\d{1,12}$/.test(id) || (typeof musicas !== "string" && typeof pasta !== "string")) {
      return res.status(400).json({ erro: "Informe a playlist e os caminhos das músicas ou uma pasta." });
    }
    if ((musicas || pasta).length > 10000) return res.status(400).json({ erro: "O conteúdo enviado é muito grande." });
    const form = new URLSearchParams();
    if (musicas) form.set("musicas", musicas);
    if (pasta) form.set("pasta", pasta);
    if (req.body?.tipo) form.set("tipo", String(req.body.tipo).slice(0, 50));
    if (req.body?.posicao) form.set("posicao", String(req.body.posicao).slice(0, 30));
    if (req.body?.ignorar_inexistentes === true) form.set("ignorar_inexistentes", "1");
    enviar(res, await xcast(res, `${caminhoPublico("playlist-adicionar")}/${id}`, { method: "POST", body: form }));
  });

  router.post("/playlists/:id/remover", async (req, res) => {
    const id = String(req.params.id);
    const posicoes = String(req.body?.posicoes ?? "");
    if (!/^\d{1,12}$/.test(id) || !/^\d+(?:\s*,\s*\d+)*$/.test(posicoes) || posicoes.length > 1000) {
      return res.status(400).json({ erro: "Informe posições válidas, separadas por vírgula (contagem a partir de 1)." });
    }
    enviar(res, await xcast(res, `${caminhoPublico("playlist-remover")}/${id}`, {
      method: "POST", body: new URLSearchParams({ posicoes })
    }));
  });

  router.post("/playlists/:id/ordenar", async (req, res) => {
    const id = String(req.params.id);
    if (!/^\d{1,12}$/.test(id)) return res.status(400).json({ erro: "Playlist inválida." });
    const form = new URLSearchParams();
    if (req.body?.misturar === true) form.set("misturar", "1");
    else if (typeof req.body?.ordem === "string" && req.body.ordem.length <= 5000) form.set("ordem", req.body.ordem);
    else return res.status(400).json({ erro: "Informe a nova ordem ou solicite mistura." });
    enviar(res, await xcast(res, `${caminhoPublico("playlist-ordenar")}/${id}`, { method: "POST", body: form }));
  });

  router.put("/playlists/:id/salvar", async (req, res) => {
    const id = String(req.params.id);
    const itens = req.body?.itens;
    if (!/^\d{1,12}$/.test(id) || !Array.isArray(itens) || itens.length > 500 ||
        itens.some((item) => !item || typeof item.path !== "string" || item.path.length > 1000)) {
      return res.status(400).json({ erro: "Lista de itens inválida." });
    }
    enviar(res, await xcast(res, `${caminhoPublico("playlist-salvar")}/${id}`, { method: "POST", body: { itens } }));
  });

  return router;
}

module.exports = criarRotasXCast;
