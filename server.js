
const express = require("express");
const session = require("express-session");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;
const PUBLIC_DIR = path.join(__dirname, "public");

if (!process.env.SESSION_SECRET || !process.env.ADMIN_PASSWORD) {
  console.error(
    "Configure SESSION_SECRET e ADMIN_PASSWORD nas variáveis de ambiente."
  );
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("Configure DATABASE_URL com a conexão do Neon.");
  process.exit(1);
}

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    name: "amvoices.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: "auto",
      sameSite: "lax",
      maxAge: 4 * 60 * 60 * 1000
    }
  })
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000
});

pool.on("error", (err) => {
  console.error("Erro inesperado no Neon:", err.message);
});

function exigirAdmin(req, res, next) {
  if (req.session?.admin === true) return next();

  return res.status(401).json({
    erro: "Acesso administrativo necessário."
  });
}

function texto(valor, limite = 200) {
  return (
    typeof valor === "string" &&
    valor.trim().length > 0 &&
    valor.trim().length <= limite
  );
}

function horarioValido(valor) {
  return (
    typeof valor === "string" &&
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(valor)
  );
}

// Obtém a data atual usando o fuso horário de Manaus.
function dataLocalManaus() {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Manaus",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const partesData = {};

  for (const parte of partes) {
    if (parte.type !== "literal") {
      partesData[parte.type] = parte.value;
    }
  }

  return `${partesData.year}-${partesData.month}-${partesData.day}`;
}

function urlAudioValida(valor) {
  if (!valor) return true;

  if (typeof valor !== "string" || valor.length > 1000) {
    return false;
  }

  if (valor.startsWith("/") && !valor.startsWith("//")) {
    return true;
  }

  try {
    return new URL(valor).protocol === "https:";
  } catch {
    return false;
  }
}

// Valida o link do material em PDF.
function urlPdfValida(valor) {
  if (valor === undefined || valor === null || valor === "") {
    return true;
  }

  if (typeof valor !== "string" || valor.length > 2000) {
    return false;
  }

  try {
    return new URL(valor.trim()).protocol === "https:";
  } catch {
    return false;
  }
}

// Prepara o banco sem apagar os registros existentes.
async function prepararBanco() {
  await pool.query(`
    ALTER TABLE programas
      ADD COLUMN IF NOT EXISTS codigo_externo TEXT,
      ADD COLUMN IF NOT EXISTS idioma VARCHAR(50),
      ADD COLUMN IF NOT EXISTS pdf_url TEXT
  `);

  await pool.query(`
    ALTER TABLE programacao
      ADD COLUMN IF NOT EXISTS codigo_externo TEXT
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_programas_codigo_externo
      ON programas (codigo_externo)
      WHERE codigo_externo IS NOT NULL
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_programacao_codigo_externo
      ON programacao (codigo_externo)
      WHERE codigo_externo IS NOT NULL
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_programacao_horarios
      ON programacao (dia_semana, horario_inicio)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_programacao_programa
      ON programacao (programa_id)
  `);

  // Contador de visitas: uma linha por dia, sem apagar o histórico.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS visitas_radio_diarias (
      data_local DATE PRIMARY KEY,
      quantidade BIGINT NOT NULL DEFAULT 0
    )
  `);

  console.log("Estrutura do Neon conferida.");
}

// Páginas do site.
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    dotfiles: "deny"
  })
);

// Estado do servidor.
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    radio: "Amazon Voices Radio",
    slogan: "Many Voices, One Connection",
    horarioServidor: new Date().toISOString()
  });
});

// Teste da conexão com o Neon.
app.get("/api/teste-neon", async (req, res, next) => {
  try {
    const resultado = await pool.query(
      "SELECT NOW() AS horario, current_database() AS banco"
    );

    res.json({
      conectado: true,
      mensagem: "Conexão com o Neon funcionando!",
      banco: resultado.rows[0].banco,
      horario: resultado.rows[0].horario
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// CONTADOR DE VISITAS DA RÁDIO
// ============================================================

// Registra uma visita quando a página pública solicita a rota.
// A página deve chamar esta rota uma única vez por carregamento,
// e não durante a atualização periódica da programação.
app.post("/api/visitas", async (req, res, next) => {
  try {
    const data = dataLocalManaus();

    await pool.query(
      `
      INSERT INTO visitas_radio_diarias (data_local, quantidade)
      VALUES ($1::date, 1)
      ON CONFLICT (data_local)
      DO UPDATE SET
        quantidade = visitas_radio_diarias.quantidade + 1
      `,
      [data]
    );

    const resultado = await pool.query(`
      SELECT
        COALESCE(SUM(quantidade), 0)::text AS total,
        COALESCE(
          SUM(quantidade) FILTER (
            WHERE data_local = $1::date
          ),
          0
        )::text AS hoje
      FROM visitas_radio_diarias
    `, [data]);

    res.json({
      total: Number(resultado.rows[0].total),
      hoje: Number(resultado.rows[0].hoje)
    });
  } catch (err) {
    next(err);
  }
});

// Métricas protegidas: somente o administrador autenticado pode consultar.
app.get("/api/admin/visitas", exigirAdmin, async (req, res, next) => {
  try {
    const data = dataLocalManaus();

    const totais = await pool.query(`
      SELECT
        COALESCE(SUM(quantidade), 0)::text AS total,
        COALESCE(
          SUM(quantidade) FILTER (
            WHERE data_local = $1::date
          ),
          0
        )::text AS hoje
      FROM visitas_radio_diarias
    `, [data]);

    const historico = await pool.query(`
      SELECT
        TO_CHAR(data_local, 'DD/MM/YYYY') AS data,
        quantidade::text AS quantidade
      FROM visitas_radio_diarias
      ORDER BY data_local DESC
      LIMIT 30
    `);

    res.json({
      total: Number(totais.rows[0].total),
      hoje: Number(totais.rows[0].hoje),
      historico: historico.rows.map((item) => ({
        data: item.data,
        quantidade: Number(item.quantidade)
      }))
    });
  } catch (err) {
    next(err);
  }
});

// Lista de programas, áudios e materiais em PDF.
app.get("/api/programas", async (req, res, next) => {
  try {
    const resultado = await pool.query(`
      SELECT
        id,
        COALESCE(codigo_externo, id::text) AS codigo,
        nome,
        idioma,
        descricao,
        url_audio,
        pdf_url,
        ativo,
        criado_em
      FROM programas
      ORDER BY nome
    `);

    res.json(
      resultado.rows.map((p) => ({
        id: p.codigo,
        titulo: p.nome,
        nome: p.nome,
        idioma: p.idioma || "",
        descricao: p.descricao || "",
        audioUrl: p.url_audio || "",
        url_audio: p.url_audio || "",
        url: p.url_audio || "",
        pdfUrl: p.pdf_url || "",
        pdf_url: p.pdf_url || "",
        ativo: p.ativo,
        criadoEm: p.criado_em
      }))
    );
  } catch (err) {
    next(err);
  }
});

// Programação antiga: permanece separada das novas playlists.
app.get("/api/programacao", async (req, res, next) => {
  try {
    const resultado = await pool.query(`
      SELECT
        pg.id,
        COALESCE(pg.codigo_externo, pg.id::text) AS codigo,
        COALESCE(p.codigo_externo, p.id::text) AS programa_codigo,
        pg.dia_semana,
        pg.horario_inicio,
        pg.horario_fim,
        pg.descricao,
        pg.ativo
      FROM programacao pg
      JOIN programas p ON p.id = pg.programa_id
      ORDER BY pg.dia_semana NULLS FIRST, pg.horario_inicio
    `);

    res.json(
      resultado.rows.map((h) => {
        const inicio = String(h.horario_inicio).slice(0, 5);
        const fim = String(h.horario_fim).slice(0, 5);

        return {
          id: h.codigo,
          programaId: h.programa_codigo,
          diaSemana: h.dia_semana,
          horario: inicio,
          inicio,
          fim,
          descricao: h.descricao || "",
          ativo: h.ativo
        };
      })
    );
  } catch (err) {
    next(err);
  }
});

// Login administrativo.
app.post("/api/admin/login", (req, res, next) => {
  const { senha } = req.body || {};

  if (
    typeof senha !== "string" ||
    senha.length > 1024 ||
    senha !== process.env.ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      erro: "Senha incorreta."
    });
  }

  req.session.regenerate((err) => {
    if (err) return next(err);

    req.session.admin = true;

    req.session.save((saveErr) => {
      if (saveErr) return next(saveErr);

      res.json({
        sucesso: true,
        mensagem: "Acesso autorizado."
      });
    });
  });
});

// Verifica a sessão administrativa.
app.get("/api/admin/sessao", (req, res) => {
  res.json({
    autenticado: req.session?.admin === true
  });
});

// Logout.
app.post("/api/admin/logout", exigirAdmin, (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);

    res.clearCookie("amvoices.sid");
    res.json({ sucesso: true });
  });
});

// Cadastro de programas, áudios e PDFs.
app.post("/api/admin/programas", exigirAdmin, async (req, res, next) => {
  try {
    const dados = req.body || {};
    const nome = dados.titulo ?? dados.nome;
    const idioma = dados.idioma || "Português";
    const descricao = dados.descricao || "";

    const audio =
      dados.audioUrl ??
      dados.url_audio ??
      dados.url ??
      dados.audio ??
      "";

    const pdf =
      dados.pdfUrl ??
      dados.pdf_url ??
      dados.pdf ??
      "";

    const codigo = texto(dados.id, 100)
      ? dados.id.trim()
      : crypto.randomUUID();

    if (
      !texto(nome, 150) ||
      !texto(idioma, 50) ||
      typeof descricao !== "string" ||
      descricao.length > 500 ||
      !urlAudioValida(audio) ||
      !urlPdfValida(pdf)
    ) {
      return res.status(400).json({
        erro:
          "Confira o nome, idioma, descrição, endereço do áudio e link do PDF."
      });
    }

    const resultado = await pool.query(
      `
      INSERT INTO programas
        (
          codigo_externo,
          nome,
          idioma,
          descricao,
          url_audio,
          pdf_url,
          ativo
        )
      VALUES ($1, $2, $3, $4, $5, $6, TRUE)
      RETURNING
        id,
        codigo_externo,
        nome,
        idioma,
        descricao,
        url_audio,
        pdf_url,
        ativo
      `,
      [
        codigo,
        nome.trim(),
        idioma.trim(),
        descricao.trim(),
        typeof audio === "string" ? audio.trim() : "",
        typeof pdf === "string" ? pdf.trim() : ""
      ]
    );

    const p = resultado.rows[0];

    res.status(201).json({
      sucesso: true,
      programa: {
        id: p.codigo_externo || String(p.id),
        titulo: p.nome,
        nome: p.nome,
        idioma: p.idioma,
        descricao: p.descricao,
        audioUrl: p.url_audio,
        url_audio: p.url_audio,
        url: p.url_audio,
        pdfUrl: p.pdf_url || "",
        pdf_url: p.pdf_url || "",
        ativo: p.ativo
      }
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({
        erro: "Já existe um programa com esse identificador."
      });
    }

    next(err);
  }
});

// Salva a programação antiga.
// Não modifica as novas faixas horárias.
app.put(
  "/api/admin/programacao",
  exigirAdmin,
  async (req, res, next) => {
    let lista = req.body;

    if (!Array.isArray(lista) || lista.length > 500) {
      return res.status(400).json({
        erro: "Envie uma lista válida de até 500 horários."
      });
    }

    for (const item of lista) {
      const inicio = item?.inicio ?? item?.horario;

      if (
        !item ||
        !texto(item.programaId, 100) ||
        !horarioValido(inicio) ||
        (item.diaSemana !== undefined &&
          item.diaSemana !== null &&
          (!Number.isInteger(item.diaSemana) ||
            item.diaSemana < 0 ||
            item.diaSemana > 6))
      ) {
        return res.status(400).json({
          erro: "Há um horário inválido na programação."
        });
      }
    }

    const unicos = new Map();

    for (const item of lista) {
      const inicio = item.inicio ?? item.horario;
      const dia = item.diaSemana ?? "todos";
      unicos.set(`${dia}|${inicio}`, item);
    }

    lista = [...unicos.values()];

    const ids = new Set();

    for (const item of lista) {
      if (
        (item.id !== undefined && !texto(item.id, 100)) ||
        (item.ativo !== undefined && typeof item.ativo !== "boolean") ||
        (item.fim !== undefined && !horarioValido(item.fim)) ||
        (item.id && ids.has(item.id))
      ) {
        return res.status(400).json({
          erro: "Há um horário inválido ou identificador duplicado."
        });
      }

      if (item.id) ids.add(item.id);
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const resolvidos = [];

      for (const item of lista) {
        const codigoPrograma = String(item.programaId);

        const programa = await client.query(
          `
          SELECT id
          FROM programas
          WHERE codigo_externo = $1 OR id::text = $1
          LIMIT 1
          `,
          [codigoPrograma]
        );

        if (!programa.rowCount) {
          throw Object.assign(
            new Error("Programa não encontrado: " + codigoPrograma),
            { status: 400 }
          );
        }

        const inicio = item.inicio ?? item.horario;
        let fim = item.fim;

        if (!fim) {
          const [h, m] = inicio.split(":").map(Number);
          const minutos = (h * 60 + m + 60) % (24 * 60);

          fim =
            String(Math.floor(minutos / 60)).padStart(2, "0") +
            ":" +
            String(minutos % 60).padStart(2, "0");
        }

        if (inicio === fim) {
          throw Object.assign(
            new Error("O início e o fim não podem ser iguais."),
            { status: 400 }
          );
        }

        resolvidos.push({
          codigo: texto(item.id, 100)
            ? item.id.trim()
            : crypto.randomUUID(),
          programaId: programa.rows[0].id,
          diaSemana: item.diaSemana ?? null,
          inicio,
          fim,
          descricao:
            typeof item.descricao === "string"
              ? item.descricao.slice(0, 500)
              : "",
          ativo: item.ativo !== false
        });
      }

      // Exclusão restrita à programação antiga.
      await client.query("DELETE FROM programacao");

      for (const h of resolvidos) {
        await client.query(
          `
          INSERT INTO programacao
            (
              codigo_externo,
              programa_id,
              dia_semana,
              horario_inicio,
              horario_fim,
              descricao,
              ativo
            )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          `,
          [
            h.codigo,
            h.programaId,
            h.diaSemana,
            h.inicio,
            h.fim,
            h.descricao,
            h.ativo
          ]
        );
      }

      await client.query("COMMIT");

      res.json({
        sucesso: true,
        total: resolvidos.length,
        mensagem: "Programação salva com sucesso."
      });
    } catch (err) {
      await client.query("ROLLBACK");

      if (err.status === 400) {
        return res.status(400).json({ erro: err.message });
      }

      next(err);
    } finally {
      client.release();
    }
  }
);

// ============================================================
// FAIXAS HORÁRIAS COM PLAYLISTS ORDENADAS
// ============================================================

// Lista as faixas horárias, seus áudios e seus PDFs.
app.get("/api/faixas-horarias", async (req, res, next) => {
  try {
    const resultado = await pool.query(`
      SELECT
        f.id,
        f.nome,
        f.descricao,
        f.dia_semana,
        TO_CHAR(f.horario_inicio, 'HH24:MI') AS inicio,
        TO_CHAR(f.horario_fim, 'HH24:MI') AS fim,
        f.ativo,
        COALESCE(
          json_agg(
            json_build_object(
              'ordem', pi.ordem,
              'programaId', COALESCE(p.codigo_externo, p.id::text),
              'titulo', p.nome,
              'idioma', p.idioma,
              'descricao', p.descricao,
              'audioUrl', p.url_audio,
              'pdfUrl', p.pdf_url
            )
            ORDER BY pi.ordem
          ) FILTER (WHERE pi.id IS NOT NULL),
          '[]'::json
        ) AS playlist
      FROM faixas_horarias f
      LEFT JOIN playlist_itens pi
        ON pi.faixa_id = f.id AND pi.ativo = TRUE
      LEFT JOIN programas p ON p.id = pi.programa_id
      GROUP BY f.id
      ORDER BY f.dia_semana NULLS FIRST, f.horario_inicio, f.id
    `);

    res.json(
      resultado.rows.map((f) => ({
        id: String(f.id),
        nome: f.nome,
        descricao: f.descricao || "",
        diaSemana: f.dia_semana,
        inicio: f.inicio,
        fim: f.fim,
        ativo: f.ativo,
        playlist: f.playlist
      }))
    );
  } catch (err) {
    next(err);
  }
});

// Cria uma faixa horária e sua playlist inicial.
app.post(
  "/api/admin/faixas-horarias",
  exigirAdmin,
  async (req, res, next) => {
    const dados = req.body || {};
    const nome = dados.nome;
    const descricao = dados.descricao || "";
    const diaSemana = dados.diaSemana ?? null;
    const inicio = dados.inicio;
    const fim = dados.fim;
    const itens = dados.itens;

    if (
      !texto(nome, 150) ||
      typeof descricao !== "string" ||
      descricao.length > 1000 ||
      !horarioValido(inicio) ||
      !horarioValido(fim) ||
      inicio === fim ||
      (diaSemana !== null &&
        (!Number.isInteger(diaSemana) ||
          diaSemana < 0 ||
          diaSemana > 6)) ||
      !Array.isArray(itens) ||
      itens.length < 1 ||
      itens.length > 100
    ) {
      return res.status(400).json({
        erro:
          "Confira o nome, os horários, o dia da semana e os áudios da playlist."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const faixaResult = await client.query(
        `
        INSERT INTO faixas_horarias
          (nome, descricao, dia_semana, horario_inicio, horario_fim, ativo)
        VALUES ($1, $2, $3, $4, $5, TRUE)
        RETURNING
          id, nome, descricao, dia_semana,
          TO_CHAR(horario_inicio, 'HH24:MI') AS inicio,
          TO_CHAR(horario_fim, 'HH24:MI') AS fim,
          ativo
        `,
        [nome.trim(), descricao.trim(), diaSemana, inicio, fim]
      );

      const faixa = faixaResult.rows[0];
      const ordens = new Set();

      for (let i = 0; i < itens.length; i++) {
        const item = itens[i];
        const programaCodigo = item?.programaId;
        const ordem = item?.ordem ?? i + 1;

        if (
          !texto(String(programaCodigo ?? ""), 100) ||
          !Number.isInteger(ordem) ||
          ordem < 1 ||
          ordens.has(ordem)
        ) {
          throw Object.assign(
            new Error("Há um item inválido ou ordem repetida na playlist."),
            { status: 400 }
          );
        }

        ordens.add(ordem);

        const programa = await client.query(
          `
          SELECT id
          FROM programas
          WHERE codigo_externo = $1 OR id::text = $1
          LIMIT 1
          `,
          [String(programaCodigo)]
        );

        if (!programa.rowCount) {
          throw Object.assign(
            new Error("Programa não encontrado: " + programaCodigo),
            { status: 400 }
          );
        }

        await client.query(
          `
          INSERT INTO playlist_itens
            (faixa_id, programa_id, ordem, ativo)
          VALUES ($1, $2, $3, TRUE)
          `,
          [faixa.id, programa.rows[0].id, ordem]
        );
      }

      await client.query("COMMIT");

      res.status(201).json({
        sucesso: true,
        faixa: {
          id: String(faixa.id),
          nome: faixa.nome,
          descricao: faixa.descricao,
          diaSemana: faixa.dia_semana,
          inicio: faixa.inicio,
          fim: faixa.fim,
          ativo: faixa.ativo
        },
        totalAudios: itens.length,
        mensagem: "Faixa horária e playlist cadastradas com sucesso."
      });
    } catch (err) {
      await client.query("ROLLBACK");

      if (err.status === 400) {
        return res.status(400).json({ erro: err.message });
      }

      next(err);
    } finally {
      client.release();
    }
  }
);

// Atualiza a playlist.
// Uma lista vazia é válida: remove todos os áudios.
app.put(
  "/api/admin/faixas-horarias/:id/playlist",
  exigirAdmin,
  async (req, res, next) => {
    const faixaId = req.params.id;
    const itens = req.body?.itens;

    if (
      !/^\d+$/.test(faixaId) ||
      !Array.isArray(itens) ||
      itens.length > 100
    ) {
      return res.status(400).json({
        erro: "Informe uma faixa válida e uma playlist com até 100 áudios."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const faixa = await client.query(
        "SELECT id FROM faixas_horarias WHERE id = $1 FOR UPDATE",
        [faixaId]
      );

      if (!faixa.rowCount) {
        throw Object.assign(
          new Error("Faixa horária não encontrada."),
          { status: 400 }
        );
      }

      await client.query(
        "DELETE FROM playlist_itens WHERE faixa_id = $1",
        [faixaId]
      );

      const ordens = new Set();

      for (let i = 0; i < itens.length; i++) {
        const item = itens[i];
        const programaCodigo = item?.programaId;
        const ordem = item?.ordem ?? i + 1;

        if (
          !texto(String(programaCodigo ?? ""), 100) ||
          !Number.isInteger(ordem) ||
          ordem < 1 ||
          ordens.has(ordem)
        ) {
          throw Object.assign(
            new Error("Há um item inválido ou ordem repetida na playlist."),
            { status: 400 }
          );
        }

        ordens.add(ordem);

        const programa = await client.query(
          `
          SELECT id
          FROM programas
          WHERE codigo_externo = $1 OR id::text = $1
          LIMIT 1
          `,
          [String(programaCodigo)]
        );

        if (!programa.rowCount) {
          throw Object.assign(
            new Error("Programa não encontrado: " + programaCodigo),
            { status: 400 }
          );
        }

        await client.query(
          `
          INSERT INTO playlist_itens
            (faixa_id, programa_id, ordem, ativo)
          VALUES ($1, $2, $3, TRUE)
          `,
          [faixaId, programa.rows[0].id, ordem]
        );
      }

      await client.query("COMMIT");

      res.json({
        sucesso: true,
        faixaId: String(faixaId),
        totalAudios: itens.length,
        mensagem: itens.length
          ? "Playlist atualizada com sucesso."
          : "Todos os áudios foram removidos da playlist."
      });
    } catch (err) {
      await client.query("ROLLBACK");

      if (err.status === 400) {
        return res.status(400).json({ erro: err.message });
      }

      next(err);
    } finally {
      client.release();
    }
  }
);

// Exclui uma faixa horária inteira e sua playlist.
app.delete(
  "/api/admin/faixas-horarias/:id",
  exigirAdmin,
  async (req, res, next) => {
    const faixaId = req.params.id;

    if (!/^\d+$/.test(faixaId)) {
      return res.status(400).json({
        erro: "Identificador de faixa horária inválido."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const faixa = await client.query(
        "SELECT id, nome FROM faixas_horarias WHERE id = $1 FOR UPDATE",
        [faixaId]
      );

      if (!faixa.rowCount) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          erro: "Essa faixa horária já não existe."
        });
      }

      await client.query(
        "DELETE FROM playlist_itens WHERE faixa_id = $1",
        [faixaId]
      );

      await client.query(
        "DELETE FROM faixas_horarias WHERE id = $1",
        [faixaId]
      );

      await client.query("COMMIT");

      res.json({
        sucesso: true,
        faixaId: String(faixaId),
        mensagem: "Faixa horária e playlist excluídas com sucesso."
      });
    } catch (err) {
      await client.query("ROLLBACK");
      next(err);
    } finally {
      client.release();
    }
  }
);

// Tratamento geral de erros.
app.use((err, req, res, next) => {
  console.error("Erro na aplicação:", err.message);

  if (res.headersSent) return next(err);

  res.status(err.status || 500).json({
    erro:
      err.status && err.status < 500
        ? err.message
        : "Ocorreu um erro interno no servidor."
  });
});

// Inicialização.
async function iniciar() {
  try {
    await prepararBanco();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(
        `Amazon Voices Radio disponível na porta ${PORT}`
      );
    });
  } catch (err) {
    console.error(
      "Não foi possível preparar o banco:",
      err.message
    );
    process.exit(1);
  }
}

iniciar();

async function encerrar() {
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", encerrar);
process.on("SIGINT", encerrar);
