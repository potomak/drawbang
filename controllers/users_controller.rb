class UsersController
  #
  # GET /users/:id
  #
  get '/users/:id' do |id|
    @user = User.find(id)
    
    if @user
      @drawings = Drawing.all(:user_id => id, :page => @page, :per_page => PER_PAGE, :host => request.host)
      
      if request.xhr?
        haml :'drawings/gallery', :locals => {:drawings => @drawings}, :layout => false
      else
        if json_request?
          {
            :uid        => @user['uid'],
            :first_name => @user['user_info']['first_name'],
            :image      => @user['user_info']['image']
          }.merge({
            :drawings   => {
              :drawings => @drawings,
              :meta     => {:current_page => @current_page}
            }
          }).to_json
        else
          haml :'users/show'
        end
      end
    else
      status 404
    end
  end
end