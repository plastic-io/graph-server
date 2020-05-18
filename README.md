# Installation

1. Setup AWS CLI profile on the machine you are using to deploy this project
2. `git clone git@github.com:plastic-io/graph-server.git`
3. `cd graph-server`
4. `npm install`
5. `sls deploy`

Your service is ready to use.  Take note of the WSS and HTTP domain names.  You will need them when using the [Plastic-IO IDE](https://github.com/plastic-io/graph-editor) and running your server based graphs.

# Plastic-IO Graph Server

* Plastic-IO Graph Scheduler Service
* Plastic-IO Graph Editor IDE Notification Service
* HTTP Graph Scheduler Host
* HTTP/WSS Graph API
* S3 Event Sourced Graph Database
* S3 Artifact Storage
* APIGWv2 Multiuser Connection Manager

# What is this server?

This server provides graph services to the [Plastic-IO IDE](https://github.com/plastic-io/graph-editor) as well as the production runtime for Plastic-IO graphs.

Additionally, this server provides a multi user environment to develop, share, and monitor Plastic-IO graphs.

# What are Plastic-IO Graphs?

Plastic-IO graphs are a high level graph programming language built on top of JavaScript and executed with the [Plastic-IO Scheduling Engine](https://github.com/plastic-io/plastic-io).  Plastic-IO graphs are stored as JSON files.  The GUI for [Plastic-IO IDE](https://github.com/plastic-io/graph-editor).

# Executing Graphs

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

Because each vector and graph in Plastic-IO are implictly modular, this makes it so you can reuse the artifacts you create in other graphs very easily.  Plastic-IO graph server provides a marketplace of graphs and vectors for developers to choose from, safely and securely.

See https://github.com/plastic-io/graph-editor for for the GUI client for this server.

