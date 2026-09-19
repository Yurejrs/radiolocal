# RadioStore

RadioStore é uma rádio indoor local para supermercados e outros ambientes comerciais. O sistema administra músicas e anúncios, normaliza os áudios no servidor e reproduz uma fila dinâmica com intercalação configurável.

## Recursos

- Player local com alternância entre músicas e anúncios.
- Biblioteca com busca, ordenação, reprodução e exclusão.
- Upload individual e em lote com progresso por arquivo.
- Conversão e normalização de áudio usando FFmpeg.
- Categorias de anúncios com prioridade e associação aos arquivos.
- Histórico recente e configurações da programação.
- Autenticação local do operador `radio`.
- Primeiro acesso com criação obrigatória de senha.
- Sessão com expiração por inatividade e logout.
- Tema claro padrão e modo noturno por navegador.

## Requisitos

- Para Docker: Docker Desktop (Windows) ou Docker com o plugin Compose.
- Para execução sem Docker: Node.js 20 ou superior, FFmpeg e FFprobe.

## Execução local

Instale as dependências:

```bash
npm ci
```

Inicie o servidor:

```bash
npm start
```

Abra [http://localhost:3000](http://localhost:3000). No primeiro acesso, crie a senha do usuário `radio`.

Para desenvolvimento com reinício automático:

```bash
npm run dev
```

## Execução com Docker

### Windows (instalação recomendada)

Baixe e extraia o arquivo `RadioStore-beta-vX.Y.Z.zip` anexado à release. Com o Docker Desktop aberto, execute o PowerShell na pasta extraída:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install.ps1
```

O instalador valida o pacote, constrói o container, aguarda o serviço responder e abre o RadioStore no navegador. O Node.js e o FFmpeg não precisam ser instalados no Windows nesse modo, pois já estão incluídos na imagem Docker.

### Outros sistemas

Suba o serviço em segundo plano:

```bash
docker compose up -d --build
```

Consulte os logs:

```bash
docker compose logs -f radiostore
```

Verifique o serviço:

```bash
curl http://localhost:3000/api/health
```

Pare os containers:

```bash
docker compose down
```

Os dados ficam no volume Docker `radiostore_data`, incluindo o banco SQLite e os áudios convertidos.

## Senha e acesso

O usuário inicial é `radio`. A senha é criada no primeiro acesso e armazenada com hash seguro no banco.

Para redefinir a senha diretamente no servidor:

```bash
npm run reset-password -- nova-senha-segura
```

Em Docker, execute o comando dentro do container:

```bash
docker compose exec radiostore npm run reset-password -- nova-senha-segura
```

A redefinição encerra as sessões existentes. Use uma senha com pelo menos 8 caracteres.

## Comandos úteis

Executar os testes automatizados:

```bash
npm test
```

Validar a sintaxe dos arquivos JavaScript:

```bash
node --check server.js
node --check public/app.js
node --check public/login.js
node --check scripts/reset-password.js
```

Validar o formato do diff antes de um commit:

```bash
git diff --check
```

Ver o estado do repositório:

```bash
git status
```

Atualizar o serviço Docker após alterações:

```bash
docker compose up -d --build
```

## Estrutura principal

```text
server.js                 API Fastify, SQLite, autenticação e processamento de áudio
public/index.html         Painel autenticado
public/app.js             Player, biblioteca, categorias e fila de upload
public/styles.css         Sistema visual claro/escuro
public/login.html         Tela de login e primeiro acesso
public/login.js           Fluxo de autenticação no navegador
scripts/reset-password.js Recuperação administrativa de senha
test/api.test.js          Testes de API e autenticação
Dockerfile                Imagem de produção com FFmpeg
docker-compose.yml        Execução local persistente via Docker
```

## API principal

Todas as operações, exceto health e autenticação, exigem sessão autenticada.

| Endpoint | Uso |
| --- | --- |
| `GET /api/health` | Verificar se o serviço está ativo |
| `GET /api/auth/status` | Consultar estado do primeiro acesso/sessão |
| `POST /api/auth/setup` | Criar a senha inicial |
| `POST /api/auth/login` | Entrar como `radio` |
| `POST /api/auth/logout` | Encerrar a sessão |
| `GET /api/tracks` | Listar músicas e anúncios |
| `POST /api/upload` | Enviar e processar áudios |
| `GET /api/categories` | Listar categorias de anúncios |
| `GET /api/queue/next` | Obter o próximo item da programação |
| `GET/PUT /api/settings` | Consultar ou alterar a regra da fila |

## Dados e manutenção

Por padrão, o banco fica em `data/radiostore.db` e os arquivos convertidos em `data/audio/`. Em produção, prefira o volume Docker para evitar perda dos dados durante recriações do container.

O FFmpeg normaliza os arquivos enviados para MP3 estéreo, 44,1 kHz, 128 kbps e loudness alvo de -14 LUFS.

## Releases

As releases beta seguem tags no formato:

```text
beta-vX.Y.Z
```

Versão atualmente publicada: `beta-v0.3.0`.

Cada nova tag gera automaticamente um ZIP de instalação e seu arquivo de verificação SHA-256. A publicação é interrompida se algum arquivo necessário, inclusive `scripts/install.ps1`, estiver ausente.
