class Redirect
  def initialize(app)
    @app = app
  end
  
  def call(env)
    if env['HTTP_HOST'] =~ /draw\.heroku\.com/
      [301, { 'Location' => Rack::Request.new(env).url.sub(/draw\.heroku\.com/i, 'drawbang.com') }, ['Redirecting...']]
    else
      @app.call(env)
    end
  end
  
end