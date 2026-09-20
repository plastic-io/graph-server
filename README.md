# Installation

1. [Install serverless and setup your AWS profile](https://www.serverless.com/framework/docs/getting-started/)
2. `git clone git@github.com:plastic-io/graph-server.git`
3. `cd graph-server`
4. `npm install`
5. `sls deploy`

Your service is ready to use. Take note of the endpoints beginning with `ANY - https://` and `wss://`.  You will need them when using the [Plastic-IO IDE](https://github.com/plastic-io/graph-editor) and running your server based graphs.  Is OK if you forget to write them down, you can see them again by running `sls info`.

# Plastic-IO Graph Server

* Plastic-IO Graph Scheduler Service
* Plastic-IO Graph Editor IDE Notification Service
* HTTP Graph Scheduler Host
* HTTP/WSS Graph API
* S3 CRDT Document Store
* S3 Artifact Storage
* APIGWv2 Multiuser Connection Manager

# What is this server?

This server provides graph services to the [Plastic-IO IDE](https://github.com/plastic-io/graph-editor) as well as the production runtime for Plastic-IO graphs.  Graph documents are stored as CRDTs, so any number of people can edit the same graph at the same time.

Additionally, this server provides a multi user environment to develop, share, and monitor Plastic-IO graphs.

# What are Plastic-IO Graphs?

Plastic-IO graphs are a high level graph programming language built on top of JavaScript and executed with the [Plastic-IO Scheduling Engine](https://github.com/plastic-io/plastic-io).  Plastic-IO graphs are stored as JSON files.  The GUI for Plastic-IO is the [Plastic-IO Graph Editor IDE](https://github.com/plastic-io/graph-editor).

# Executing Graphs on the Graph Server

You can execute graphs on the server by subscribing events to the lambda "DefaultRoute" in this project.  By default, all unbound HTTP traffic to the domain will come to the graph route.  What graph gets executed is based on the URL.

    <root>/<graph.url>.<graph.vector[].url>


    Example:
    The following URL would run vector "html" on graph "home"

    https://mysite.com/home.html

Graphs are stored by their URL.  Once the graph is looked up, the scheduler is invoked with the matching vector's URL.

If no vector URL is specified, the vector URL "index" is assumed.  Similarity, if no graph URL is specified, the graph "index" is assumed.  That makes the default route to the server "/" the graph "index" and the vector "index".

# Environments and Publishing

When you publish a graph, that graph becomes available in the production environment.  Changes to the graph will not take effect until you publish the graph once again.  You can still test your graph in the development environment after each change.

# Sharing Vectors and Graphs

When you publish your vector or graph, it becomes available to other users of your Graph Database.  These published versions are immutable and free of dependency issues.  Once a graph or vector is published, users of that artifact can be sure it will never change.  Past versions are listed right next to current versions and clearly labeled.

## Infrastructure as a Graph

Because you can share the parts of the graph, and entire hypergraphs, Plastic-IO server allows you to build your entire infrastructure using first "low level" JavaScript and then higher level graphical programming, all within the multiuser [Plastic-IO IDE](https://github.com/plastic-io/graph-editor).

## Maximize Code Reuse

Because each vector and graph in Plastic-IO are implicitly modular, this makes it so you can reuse the artifacts you create in other graphs very easily.  Plastic-IO graph server provides a marketplace of graphs and vectors for developers to choose from, safely and securely.

See https://github.com/plastic-io/graph-editor for for the GUI client for this server.

# Collaborative Editing

Graphs are [Yjs](https://yjs.dev/) documents.  An edit is a small binary update
rather than a diff against a shared baseline, and updates commute, so the order
they arrive in does not matter and two people editing at once cannot overwrite
each other.

Updates use the Yjs V2 encoding, which is about 35% smaller on graph-shaped
content.  The version is part of the storage path and is stated on every wire
message, because Yjs does not reject an update written in the other encoding,
it decodes it into a different document.  A message declaring another format is
refused.

## How a change travels

    +-----------+          +------------------+          +-----------------+
    |  Browser  |          |  yjs WS route    |          |   S3 (append)   |
    +-----+-----+          +---------+--------+          +--------+--------+
          |                          |                            |
          +---update (base64)------> |                            |
          |                          +---write one object-------> |
          |                          |                            |
          |                          +---fan out to the graph's   |
          | <------------------------+   other subscribers        |
          |                          |                            |

Handling an edit never reads the graph.  That is the whole point: the previous
design read the projection, applied a diff and wrote it back, so two edits
arriving together lost one of them.

## The list of graphs

The list is a Yjs document rather than a file. It used to be rebuilt from
scratch on every write: list every object under the projections, read the
metadata of each one, assemble the whole list and write it back. That is a
request per graph per save, and two saves landing together threw one of the
results away, because the whole file was the unit of writing.

Each entry is now a key in a document. Saving a graph writes a small update
describing that entry and nothing else, updates from different graphs merge
rather than overwrite, and the log folds into a snapshot as it grows.

| Graphs stored | Reads per save | Bytes written per save |
| --- | --- | --- |
| 100 | 0 | 45 |
| 1000 | 0 | 46 |
| 10000 | 0 | 46 |

Reads per save was previously the number of objects stored.

It builds itself the first time it is used, from the previous list if that is
still there, or from a walk of the projections if it is not. Neither path runs
twice and neither discards work done since. `POST /toc/rebuild` does the walk
on demand, as a repair tool.

`GET /toc.json` returns what it always did. `GET /toc/state?sv=` returns the
list as a document update, so a caller that already has most of it fetches
only what changed: on the current 115 graphs that is 13 bytes against 60KB.

## Storage layout

    graphs/<id>/crdt/v2/updates/<ulid>~<label>.bin  one update, with its label
    graphs/<id>/crdt/v2/snapshots/<ulid>.bin        merged state up to <ulid>
    index/toc/crdt/v2/...                           the list of graphs
    graphs/projections/latest/<id>.json           plain JSON, for execution
    graphs/<id>/projections/<id>.<version>.json   plain JSON, for publishing
    graphs/projections/endpoints/<url>.json       plain JSON, routed by URL

A reader takes the newest snapshot plus every update that sorts after it, and
answers a request by computing the difference against the caller's state vector
rather than sending the whole graph, so a browser reopening a graph it already
has transfers almost nothing.
Snapshots are an optimisation, never the source of truth, and updates are kept
after one is written: the log is also what the rewind feature replays, and
keeping it means a snapshot can never race a delete into losing data.

Graph execution, publishing and the table of contents still read plain JSON, so
a checkpoint refreshes those files once an edit has left them stale.  How stale
they may get is set by the `CHECKPOINT_INTERVAL_MS` environment variable, which
defaults to ten seconds.

## Endpoints

| Route | Purpose |
| ----- | ------- |
| `wss` route `yjs` | sync protocol and presence |
| `GET /crdt/{id}/state?sv=` | the document, or only what the caller's state vector is missing |
| `GET /crdt/{id}/state/{updateId}` | the document as it stood at one point |
| `GET /crdt/{id}/history` | the action log, for rewind |
| `POST /crdt/{id}/update` | fallback for updates too large for a frame |
| `POST /crdt/{id}/checkpoint` | force the JSON projections up to date |
| `GET /toc.json` | the list of graphs |
| `GET /toc/state?sv=` | the list as a document update, differentially |
| `POST /toc/rebuild` | rebuild the list from the projections |
| `GET /deleted.json` | the graphs that are hidden |

Presence (pointers, selections, who is here) rides the same socket on an
awareness channel and is never stored.
